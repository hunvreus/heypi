import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Adapter, AdapterContext, AdapterKind, ChatMessage, SendMessage } from "../types.js";

type BaseAdapterConfig = {
	name?: string;
	onStart?: (context: AdapterContext) => Promise<void> | void;
	onSend?: (message: SendMessage) => Promise<{ id?: string } | void> | { id?: string } | void;
	onAck?: (message: ChatMessage) => Promise<void> | void;
};

function adapter(kind: AdapterKind, config: BaseAdapterConfig = {}): Adapter {
	return {
		kind,
		name: config.name,
		start: (context) => config.onStart?.(context),
		send: async (message) => config.onSend?.(message),
		ack: (message) => config.onAck?.(message),
	};
}

export type SlackConfig = BaseAdapterConfig & {
	token?: string;
	appToken?: string;
	signingSecret?: string;
	botUserId?: string;
};

export type DiscordConfig = BaseAdapterConfig & {
	token?: string;
};

export type TelegramConfig = BaseAdapterConfig & {
	token?: string;
};

export type WebhookConfig = BaseAdapterConfig & {
	path?: string;
	host?: string;
	port?: number;
};

export function slack(config: SlackConfig = {}): Adapter {
	let app: SlackBoltApp | undefined;
	return {
		kind: "slack",
		name: config.name,
		async start(context) {
			if (!config.token) return config.onStart?.(context);
			const { App } = (await import("@slack/bolt")) as unknown as {
				App: new (options: SlackBoltOptions) => SlackBoltApp;
			};
			app = new App({
				token: config.token,
				appToken: config.appToken,
				signingSecret: config.signingSecret,
				socketMode: Boolean(config.appToken),
			});
			app.event("app_mention", async ({ event }) => {
				await context.receive(slackMessage(event, true, false));
			});
			app.event("message", async ({ event }) => {
				if (event.channel_type !== "im") return;
				await context.receive(slackMessage(event, false, true));
			});
			await app.start();
			await config.onStart?.(context);
			context.logger.info("adapter.slack.start", { socketMode: Boolean(config.appToken) });
		},
		async stop() {
			await app?.stop();
			app = undefined;
		},
		async send(message) {
			if (config.onSend) return config.onSend(message);
			const result = await app?.client.chat.postMessage({
				channel: message.conversation,
				thread_ts: message.thread,
				text: message.text,
			});
			return { id: result?.ts };
		},
		async ack(message) {
			await config.onAck?.(message);
			if (!app || message.adapter !== "slack") return;
			await app.client.reactions
				.add({ channel: message.conversation, timestamp: message.id, name: "eyes" })
				.catch(() => undefined);
		},
	};
}

export function discord(config: DiscordConfig = {}): Adapter {
	let client: DiscordClient | undefined;
	return {
		kind: "discord",
		name: config.name,
		async start(context) {
			if (!config.token) return config.onStart?.(context);
			const discordJs = (await import("discord.js")) as unknown as DiscordJsModule;
			client = new discordJs.Client({
				intents: [
					discordJs.GatewayIntentBits.Guilds,
					discordJs.GatewayIntentBits.GuildMessages,
					discordJs.GatewayIntentBits.DirectMessages,
					discordJs.GatewayIntentBits.MessageContent,
				],
				partials: [discordJs.Partials.Channel],
			});
			client.on("messageCreate", (message) => {
				if (message.author.bot) return;
				const botId = client?.user?.id;
				const mentioned = botId ? message.mentions.users.has(botId) : false;
				const dm = message.channel.isDMBased();
				if (!mentioned && !dm) return;
				void context.receive(discordMessage(message, mentioned, dm));
			});
			await client.login(config.token);
			await config.onStart?.(context);
			context.logger.info("adapter.discord.start");
		},
		async stop() {
			client?.destroy();
			client = undefined;
		},
		async send(message) {
			if (config.onSend) return config.onSend(message);
			const channel = await client?.channels.fetch(message.conversation);
			if (!channel?.send) return undefined;
			const result = await channel.send(message.text);
			return { id: result.id };
		},
		ack: (message) => config.onAck?.(message),
	};
}

export function telegram(config: TelegramConfig = {}): Adapter {
	return adapter("telegram", config);
}

export function webhook(config: WebhookConfig = {}): Adapter {
	let server: Server | undefined;
	let context: AdapterContext | undefined;
	const host = config.host ?? "127.0.0.1";
	const port = config.port ?? 3030;
	const path = config.path ?? "/webhook";
	return {
		kind: "webhook",
		name: config.name,
		async start(nextContext) {
			context = nextContext;
			await config.onStart?.(nextContext);
			server = createServer((request, response) => {
				void handleWebhook(request, response, path, nextContext);
			});
			await new Promise<void>((resolve, reject) => {
				server?.once("error", reject);
				server?.listen(port, host, () => resolve());
			});
			nextContext.logger.info("adapter.webhook.start", { host, port, path });
		},
		async stop() {
			if (!server) return;
			await new Promise<void>((resolve, reject) => {
				server?.close((error) => (error ? reject(error) : resolve()));
			});
			server = undefined;
		},
		async send(message) {
			if (config.onSend) return config.onSend(message);
			context?.logger.info("adapter.webhook.outbound", { conversation: message.conversation, text: message.text });
			return undefined;
		},
		ack: (message) => config.onAck?.(message),
	};
}

async function handleWebhook(
	request: IncomingMessage,
	response: ServerResponse,
	path: string,
	context: AdapterContext,
): Promise<void> {
	if (request.method !== "POST" || request.url?.split("?")[0] !== path) {
		response.writeHead(404, { "content-type": "application/json" });
		response.end(JSON.stringify({ error: "not_found" }));
		return;
	}
	try {
		const body = await readJson(request);
		const message = normalizeWebhookMessage(body);
		await context.receive(message);
		response.writeHead(202, { "content-type": "application/json" });
		response.end(JSON.stringify({ ok: true }));
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		context.logger.error("adapter.webhook.error", { error: detail });
		response.writeHead(400, { "content-type": "application/json" });
		response.end(JSON.stringify({ error: detail }));
	}
}

async function readJson(request: IncomingMessage): Promise<unknown> {
	const chunks: Buffer[] = [];
	for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
	const text = Buffer.concat(chunks).toString("utf8");
	return text ? JSON.parse(text) : {};
}

function normalizeWebhookMessage(value: unknown): ChatMessage {
	if (!value || typeof value !== "object") throw new Error("webhook body must be an object");
	const input = value as Record<string, unknown>;
	const text = stringField(input, "text");
	const conversation = stringField(input, "conversation");
	const userId = stringField(input, "userId", "webhook-user");
	return {
		id: stringField(input, "id", crypto.randomUUID()),
		adapter: "webhook",
		account: stringField(input, "account", "default"),
		conversation,
		text,
		mentioned: booleanField(input, "mentioned", true),
		dm: booleanField(input, "dm", false),
		user: {
			id: userId,
			name: optionalStringField(input, "userName"),
			isBot: booleanField(input, "isBot", false),
		},
	};
}

function stringField(input: Record<string, unknown>, key: string, fallback?: string): string {
	const value = input[key];
	if (typeof value === "string" && value.length > 0) return value;
	if (fallback !== undefined) return fallback;
	throw new Error(`${key} is required`);
}

function optionalStringField(input: Record<string, unknown>, key: string): string | undefined {
	const value = input[key];
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function booleanField(input: Record<string, unknown>, key: string, fallback: boolean): boolean {
	const value = input[key];
	return typeof value === "boolean" ? value : fallback;
}

type SlackBoltOptions = {
	token: string;
	appToken?: string;
	signingSecret?: string;
	socketMode: boolean;
};

type SlackEventHandlerArgs = {
	event: Record<string, unknown>;
};

type SlackBoltApp = {
	event(name: string, handler: (args: SlackEventHandlerArgs) => Promise<void> | void): void;
	start(): Promise<void>;
	stop(): Promise<void>;
	client: {
		chat: {
			postMessage(input: { channel: string; thread_ts?: string; text: string }): Promise<{ ts?: string }>;
		};
		reactions: {
			add(input: { channel: string; timestamp: string; name: string }): Promise<unknown>;
		};
	};
};

function slackMessage(event: Record<string, unknown>, mentioned: boolean, dm: boolean): ChatMessage {
	const text = typeof event.text === "string" ? event.text : "";
	const channel = typeof event.channel === "string" ? event.channel : "unknown";
	const ts = typeof event.ts === "string" ? event.ts : crypto.randomUUID();
	const user = typeof event.user === "string" ? event.user : "unknown";
	return {
		id: ts,
		adapter: "slack",
		account: typeof event.team === "string" ? event.team : "default",
		conversation: channel,
		text,
		mentioned,
		dm,
		user: {
			id: user,
			isBot: typeof event.bot_id === "string",
		},
	};
}

type DiscordJsModule = {
	Client: new (options: { intents: number[]; partials: number[] }) => DiscordClient;
	GatewayIntentBits: Record<"Guilds" | "GuildMessages" | "DirectMessages" | "MessageContent", number>;
	Partials: Record<"Channel", number>;
};

type DiscordClient = {
	user?: { id: string };
	on(event: "messageCreate", handler: (message: DiscordMessage) => void): void;
	login(token: string): Promise<string>;
	destroy(): void;
	channels: {
		fetch(id: string): Promise<DiscordSendChannel | undefined | null>;
	};
};

type DiscordSendChannel = {
	send(content: string): Promise<{ id: string }>;
};

type DiscordMessage = {
	id: string;
	content: string;
	channelId: string;
	guildId?: string | null;
	author: {
		id: string;
		username?: string;
		bot: boolean;
	};
	channel: {
		isDMBased(): boolean;
	};
	mentions: {
		users: {
			has(id: string): boolean;
		};
	};
};

function discordMessage(message: DiscordMessage, mentioned: boolean, dm: boolean): ChatMessage {
	return {
		id: message.id,
		adapter: "discord",
		account: message.guildId ?? "dm",
		conversation: message.channelId,
		text: message.content,
		mentioned,
		dm,
		user: {
			id: message.author.id,
			name: message.author.username,
			isBot: message.author.bot,
		},
	};
}

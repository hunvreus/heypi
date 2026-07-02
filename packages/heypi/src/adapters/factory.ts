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
	return adapter("slack", config);
}

export function discord(config: DiscordConfig = {}): Adapter {
	return adapter("discord", config);
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

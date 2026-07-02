import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Adapter, AdapterContext, ChatMessage, SendMessage } from "./types.js";

export type LocalAdapter = Adapter & {
	receive(message: Omit<ChatMessage, "adapter" | "account" | "conversation"> & Partial<ChatMessage>): Promise<void>;
	sent: SendMessage[];
};

export function local(name = "local"): LocalAdapter {
	let context: AdapterContext | undefined;
	const sent: SendMessage[] = [];
	return {
		kind: "local",
		name,
		sent,
		start(nextContext) {
			context = nextContext;
		},
		async send(message) {
			sent.push(message);
			return { id: `local-${sent.length}` };
		},
		async receive(message) {
			if (!context) throw new Error("Local adapter is not started");
			await context.receive({
				adapter: "local",
				account: "local",
				conversation: "local",
				...message,
			});
		},
	};
}

export type WebhookConfig = {
	host?: string;
	port: number;
	path?: string;
	name?: string;
};

export type WebhookAdapter = Adapter & {
	sent: SendMessage[];
	url(): string;
};

async function readJson(request: IncomingMessage): Promise<unknown> {
	const chunks: Uint8Array[] = [];
	for await (const chunk of request) chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
	const text = Buffer.concat(chunks).toString("utf8");
	return text ? JSON.parse(text) : {};
}

function json(response: ServerResponse, status: number, body: unknown): void {
	response.writeHead(status, { "content-type": "application/json" });
	response.end(JSON.stringify(body));
}

function webhookMessage(input: unknown): ChatMessage {
	const record = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
	const user = record.user && typeof record.user === "object" ? (record.user as Record<string, unknown>) : {};
	return {
		id: typeof record.id === "string" ? record.id : `webhook-${Date.now()}`,
		adapter: "webhook",
		account: typeof record.account === "string" ? record.account : "webhook",
		conversation: typeof record.conversation === "string" ? record.conversation : "default",
		user: {
			id: typeof user.id === "string" ? user.id : "webhook",
			name: typeof user.name === "string" ? user.name : undefined,
			isBot: user.isBot === true,
		},
		text: typeof record.text === "string" ? record.text : "",
		mentioned: record.mentioned !== false,
		dm: record.dm === true,
		time: typeof record.time === "string" ? record.time : undefined,
		attachments: Array.isArray(record.attachments) ? (record.attachments as ChatMessage["attachments"]) : undefined,
	};
}

export function webhook(config: WebhookConfig): WebhookAdapter {
	let context: AdapterContext | undefined;
	let server: Server | undefined;
	const host = config.host ?? "127.0.0.1";
	const path = config.path ?? "/webhook";
	const sent: SendMessage[] = [];
	return {
		kind: "webhook",
		name: config.name,
		sent,
		url: () => `http://${host}:${config.port}${path}`,
		async start(nextContext) {
			context = nextContext;
			server = createServer(async (request, response) => {
				if (request.method !== "POST" || request.url !== path) return json(response, 404, { error: "not_found" });
				try {
					const message = webhookMessage(await readJson(request));
					await context?.receive(message);
					json(response, 202, { ok: true });
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					json(response, 400, { error: message });
				}
			});
			await new Promise<void>((resolve, reject) => {
				server?.once("error", reject);
				server?.listen(config.port, host, resolve);
			});
			context.logger.info("adapter.webhook.start", { url: this.url() });
		},
		async stop() {
			if (!server) return;
			await new Promise<void>((resolve, reject) => {
				server?.close((error) => (error ? reject(error) : resolve()));
			});
			server = undefined;
		},
		async send(message) {
			sent.push(message);
			return { id: `webhook-${sent.length}` };
		},
	};
}

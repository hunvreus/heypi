import { createHmac, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { type AdapterEvents, busyEvents, statusEvents } from "./events.js";
import type {
	Adapter,
	AdapterApprovalConfig,
	AdapterContext,
	AllowConfig,
	ApproverSet,
	BusyMode,
	ChatMessage,
	SendMessage,
} from "./types.js";

export type LocalMessage = Omit<ChatMessage, "account" | "adapter" | "conversation" | "dm" | "mentioned"> &
	Partial<Pick<ChatMessage, "account" | "adapter" | "conversation" | "dm" | "mentioned">>;

export type LocalAdapter = Adapter & {
	receive(message: LocalMessage): Promise<void>;
	sent: SendMessage[];
};

function localMessage(input: LocalMessage, account: string): ChatMessage {
	return {
		id: input.id,
		adapter: "local",
		account,
		conversation: "local",
		thread: input.thread,
		user: input.user,
		text: input.text,
		mentioned: input.mentioned ?? true,
		dm: input.dm ?? true,
		time: input.time,
		attachments: input.attachments,
	};
}

function progressEvents(progress: boolean | undefined, events: AdapterEvents | undefined): AdapterEvents | undefined {
	if (progress === false) return { ...busyEvents(), ...(events ?? {}) };
	return { ...statusEvents(), ...(events ?? {}) };
}

export type LocalConfig = {
	id?: string;
	allow?: AllowConfig;
	admins?: ApproverSet;
	approvers?: ApproverSet;
	approvals?: AdapterApprovalConfig;
	progress?: boolean;
	busy?: BusyMode;
	events?: AdapterEvents;
};

export function local(config: string | LocalConfig = "local"): LocalAdapter {
	let context: AdapterContext | undefined;
	const sent: SendMessage[] = [];
	const messages = new Map<string, SendMessage>();
	let nextMessage = 1;
	const resolved = typeof config === "string" ? { id: config } : config;
	const id = resolved.id ?? "local";
	return {
		kind: "local",
		id,
		allow: resolved.allow,
		admins: resolved.admins,
		approvers: resolved.approvers,
		approvals: resolved.approvals,
		progress: resolved.progress ?? true,
		busy: resolved.busy ?? "queue",
		events: progressEvents(resolved.progress, resolved.events),
		sent,
		start(nextContext) {
			context = nextContext;
		},
		async send(message) {
			sent.push(message);
			const messageId = `local-${nextMessage++}`;
			messages.set(messageId, message);
			return { id: messageId };
		},
		async update(message) {
			const previous = messages.get(message.id);
			if (!previous) return;
			const index = sent.indexOf(previous);
			if (index < 0) return;
			const updated = {
				conversation: message.conversation,
				thread: message.thread,
				text: message.text,
				attachments: message.attachments,
			};
			sent[index] = updated;
			messages.set(message.id, updated);
		},
		async remove(message) {
			const previous = messages.get(message.id);
			if (!previous) return;
			const index = sent.indexOf(previous);
			if (index >= 0) sent.splice(index, 1);
			messages.delete(message.id);
		},
		async receive(message) {
			if (!context) throw new Error("Local adapter is not started");
			await context.receive(localMessage(message, id));
		},
	};
}

export type WebhookConfig = {
	id?: string;
	host?: string;
	port: number;
	path?: string;
	secret?: string;
	signatureToleranceMs?: number;
	allow?: AllowConfig;
	admins?: ApproverSet;
	approvers?: ApproverSet;
	approvals?: AdapterApprovalConfig;
	progress?: boolean;
	busy?: BusyMode;
	events?: AdapterEvents;
};

export type WebhookAdapter = Adapter & {
	sent: SendMessage[];
	url(): string;
};

type RequestBody = {
	raw: string;
	json: unknown;
};

const MAX_WEBHOOK_BODY_BYTES = 1_000_000;

async function readBody(request: IncomingMessage): Promise<RequestBody> {
	const chunks: Uint8Array[] = [];
	let bytes = 0;
	for await (const chunk of request) {
		const data = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
		bytes += data.byteLength;
		if (bytes > MAX_WEBHOOK_BODY_BYTES) throw new Error("request body too large");
		chunks.push(data);
	}
	const text = Buffer.concat(chunks).toString("utf8");
	return { raw: text, json: text ? JSON.parse(text) : {} };
}

function json(response: ServerResponse, status: number, body: unknown): void {
	response.writeHead(status, { "content-type": "application/json" });
	response.end(JSON.stringify(body));
}

function webhookMessage(input: unknown, account: string): ChatMessage {
	const record = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
	const user = record.user && typeof record.user === "object" ? (record.user as Record<string, unknown>) : {};
	const isSelf = user.isSelf === true;
	return {
		id: typeof record.id === "string" ? record.id : `webhook-${Date.now()}`,
		adapter: "webhook",
		account: typeof record.account === "string" ? record.account : account,
		conversation: typeof record.conversation === "string" ? record.conversation : "default",
		thread: typeof record.thread === "string" ? record.thread : undefined,
		user: {
			id: typeof user.id === "string" ? user.id : "webhook",
			name: typeof user.name === "string" ? user.name : undefined,
			isBot: user.isBot === true,
			...(isSelf ? { isSelf: true } : {}),
		},
		text: typeof record.text === "string" ? record.text : "",
		mentioned: record.mentioned !== false,
		dm: record.dm === true,
		time: typeof record.time === "string" ? record.time : undefined,
		attachments: Array.isArray(record.attachments) ? (record.attachments as ChatMessage["attachments"]) : undefined,
	};
}

function secureCompare(left: string, right: string): boolean {
	const leftBuffer = Buffer.from(left);
	const rightBuffer = Buffer.from(right);
	return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function sign(secret: string, timestamp: string, rawBody: string): string {
	return createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex");
}

function verifyWebhook(request: IncomingMessage, rawBody: string, secret: string, toleranceMs: number): void {
	const timestamp = request.headers["x-heypi-timestamp"];
	const signature = request.headers["x-heypi-signature"];
	if (typeof timestamp !== "string" || typeof signature !== "string") throw new Error("Missing webhook signature");
	const seconds = Number(timestamp);
	if (!Number.isFinite(seconds)) throw new Error("Invalid webhook timestamp");
	const ageMs = Math.abs(Date.now() - seconds * 1000);
	if (ageMs > toleranceMs) throw new Error("Expired webhook signature");
	const expected = `sha256=${sign(secret, timestamp, rawBody)}`;
	if (!secureCompare(signature, expected)) throw new Error("Invalid webhook signature");
}

function isLoopback(host: string): boolean {
	return host === "127.0.0.1" || host === "::1" || host === "localhost";
}

export function webhook(config: WebhookConfig): WebhookAdapter {
	let context: AdapterContext | undefined;
	let server: Server | undefined;
	const host = config.host ?? "127.0.0.1";
	const path = config.path ?? "/webhook";
	const secret = config.secret?.trim();
	const toleranceMs = config.signatureToleranceMs ?? 5 * 60 * 1000;
	const sent: SendMessage[] = [];
	const id = config.id ?? "webhook";
	return {
		kind: "webhook",
		id,
		allow: config.allow,
		admins: config.admins,
		approvers: config.approvers,
		approvals: config.approvals,
		progress: config.progress ?? false,
		busy: config.busy ?? "queue",
		events: config.events,
		sent,
		url: () => `http://${host}:${config.port}${path}`,
		async start(nextContext) {
			if (!isLoopback(host) && !secret) throw new Error("Webhook secret is required for non-loopback hosts");
			context = nextContext;
			server = createServer(async (request, response) => {
				if (request.method !== "POST" || request.url !== path) return json(response, 404, { error: "not_found" });
				try {
					const body = await readBody(request);
					if (secret) verifyWebhook(request, body.raw, secret, toleranceMs);
					const message = webhookMessage(body.json, id);
					await context?.receive(message);
					json(response, 202, { ok: true });
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					json(response, message.includes("signature") ? 401 : 400, { error: message });
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

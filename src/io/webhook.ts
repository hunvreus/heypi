import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { message } from "../core/log.js";
import type { Adapter, AdapterStart, Outbound, StatusResult } from "./handler.js";
import { assertRouteName } from "./name.js";

export type WebhookConfig = {
	name?: string;
	secret: string;
	port?: number;
	host?: string;
	path?: string;
	unsafePathOverride?: boolean;
	syncTimeoutMs?: number;
	maxBodyBytes?: number;
	maxInFlight?: number;
	replyHosts?: string[];
};

export type WebhookMessage = {
	threadId?: string;
	user?: string;
	text?: string;
	eventId?: string;
	replyUrl?: string;
	sync?: boolean;
	timeoutMs?: number;
	data?: unknown;
};

/** Creates an HTTP webhook adapter for generic, async-first integrations. */
export function webhook(config: WebhookConfig): Adapter {
	const name = config.name ?? "webhook";
	assertRouteName(name);
	const kind = "webhook";
	if (config.path && !config.unsafePathOverride) {
		throw new Error("Webhook path override requires unsafePathOverride: true");
	}
	const base = normalizePath(config.path ?? `/webhook/${name}`);
	const maxBodyBytes = config.maxBodyBytes ?? 1_000_000;
	const maxInFlight = config.maxInFlight ?? 32;
	let server: Server | undefined;
	let start: AdapterStart | undefined;
	let inFlight = 0;

	return {
		name,
		kind,
		async start(input) {
			start = input;
			const handler = (req: IncomingMessage, res: ServerResponse) =>
				route({
					req,
					res,
					config,
					base,
					name,
					kind,
					start: input,
					maxBodyBytes,
					maxInFlight,
					inFlight: () => inFlight++,
				});
			if (input.http) {
				registerWebhookRoutes(input, { base, host: config.host, port: config.port, handler });
				input.logger.info("webhook.start", {
					adapter: name,
					kind,
					host: config.host,
					port: config.port,
					path: base,
					shared: true,
				});
				return;
			}
			const host = config.host ?? "127.0.0.1";
			if (config.port === undefined) throw new Error("Webhook standalone mode requires port");
			server = createServer((req, res) => void handler(req, res));
			await new Promise<void>((resolve, reject) => {
				server?.once("error", reject);
				server?.listen(config.port, host, () => {
					server?.off("error", reject);
					input.logger.info("webhook.start", { adapter: name, kind, host, port: config.port, path: base });
					resolve();
				});
			});
		},
		async stop() {
			await new Promise<void>((resolve, reject) => {
				if (!server) return resolve();
				server.close((error) => (error ? reject(error) : resolve()));
			});
			start?.logger.info("webhook.stop", { adapter: name, kind });
			server = undefined;
			start = undefined;
		},
	};

	function release(): void {
		inFlight = Math.max(0, inFlight - 1);
	}

	async function route(input: RouteInput): Promise<void> {
		return routeRequest({ ...input, release });
	}
}

function registerWebhookRoutes(
	start: AdapterStart,
	input: {
		base: string;
		host?: string;
		port?: number;
		handler(req: IncomingMessage, res: ServerResponse): Promise<void>;
	},
): void {
	const routes = [
		["POST", input.base],
		["POST", `${input.base}/messages`],
		["POST", `${input.base}/threads/:threadId/messages`],
		["GET", `${input.base}/threads/:threadId/runs/:runId`],
	] as const;
	for (const [method, path] of routes) {
		start.http?.register({
			method,
			path,
			host: input.host,
			port: input.port,
			handler: input.handler,
		});
	}
}

type RouteInput = {
	req: IncomingMessage;
	res: ServerResponse;
	config: WebhookConfig;
	base: string;
	name: string;
	kind: string;
	start: AdapterStart;
	maxBodyBytes: number;
	maxInFlight: number;
	inFlight(): number;
};

async function routeRequest(input: RouteInput & { release(): void }): Promise<void> {
	try {
		if (!authorized(input.req, input.config.secret))
			return json(input.res, 401, { ok: false, error: "unauthorized" });
		const url = new URL(input.req.url ?? "/", "http://localhost");
		const path = normalizePath(url.pathname);
		if (input.req.method === "POST" && (path === input.base || path === `${input.base}/messages`)) {
			return await receive(input, await body(input.req, input.maxBodyBytes));
		}
		const threadMatch = path.match(new RegExp(`^${escapeRe(input.base)}/threads/([^/]+)/messages$`));
		if (input.req.method === "POST" && threadMatch) {
			const payload = await body(input.req, input.maxBodyBytes);
			return await receive(input, { ...payload, threadId: decodeURIComponent(threadMatch[1]) });
		}
		const runMatch = path.match(new RegExp(`^${escapeRe(input.base)}/threads/([^/]+)/runs/([^/]+)$`));
		if (input.req.method === "GET" && runMatch) {
			const threadId = decodeURIComponent(runMatch[1]);
			const runId = decodeURIComponent(runMatch[2]);
			const status = await input.start.status?.({ provider: input.name, threadId, runId });
			if (!status) return json(input.res, 404, { ok: false, error: "run not found" });
			return json(input.res, 200, statusResponse(status));
		}
		return json(input.res, 404, { ok: false, error: "not found" });
	} catch (error) {
		if (error instanceof WebhookHttpError) return json(input.res, error.status, { ok: false, error: error.message });
		input.start.logger.warn("webhook.error", { adapter: input.name, error: message(error) });
		return json(input.res, 500, { ok: false, error: "webhook failed" });
	}
}

async function receive(
	input: {
		res: ServerResponse;
		name: string;
		kind: string;
		start: AdapterStart;
		config: WebhookConfig;
		maxInFlight: number;
		inFlight(): number;
		release(): void;
	},
	payload: WebhookMessage,
): Promise<void> {
	const text = payload.text?.trim();
	if (!text) return json(input.res, 400, { ok: false, error: "text is required" });
	if (payload.replyUrl) assertReplyUrl(payload.replyUrl, input.config.replyHosts);
	if (input.inFlight() >= input.maxInFlight) {
		input.release();
		return json(input.res, 429, { ok: false, error: "too many in-flight webhook runs" });
	}
	const threadId = payload.threadId?.trim() || `whth_${randomBytes(18).toString("base64url")}`;
	const runId = randomUUID();
	const done = execute(input, payload, threadId, runId).finally(input.release);
	if (payload.sync) {
		const timeoutMs = Math.min(Math.max(payload.timeoutMs ?? input.config.syncTimeoutMs ?? 25_000, 1), 30_000);
		const result = await Promise.race([done, wait(timeoutMs).then(() => undefined)]);
		return json(input.res, result ? 200 : 202, result ?? runningResponse(threadId, runId));
	}
	void done;
	json(input.res, 202, runningResponse(threadId, runId));
}

async function execute(
	input: { name: string; kind: string; start: AdapterStart },
	payload: WebhookMessage,
	threadId: string,
	runId: string,
): Promise<Record<string, unknown>> {
	try {
		const result = await input.start.handler({
			provider: input.name,
			kind: input.kind,
			eventId: payload.eventId ?? runId,
			channel: threadId,
			actor: payload.user ?? "webhook",
			thread: threadId,
			text: payload.text ?? "",
			data: payload.data,
			trace: runId,
		});
		const response = outboundResponse(threadId, runId, result);
		if (payload.replyUrl) await postReply(input.start, payload.replyUrl, response);
		return response;
	} catch (error) {
		const response = { ok: false, threadId, runId, status: "failed", error: message(error) };
		if (payload.replyUrl) await postReply(input.start, payload.replyUrl, response);
		return response;
	}
}

async function postReply(start: AdapterStart, url: string, body: Record<string, unknown>): Promise<void> {
	try {
		await fetch(url, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
		});
	} catch (error) {
		start.logger.warn("webhook.reply_failed", { error: message(error) });
	}
}

function runningResponse(threadId: string, runId: string): Record<string, unknown> {
	return { ok: true, threadId, runId, status: "running" };
}

function outboundResponse(threadId: string, runId: string, result: Outbound | undefined): Record<string, unknown> {
	return {
		ok: true,
		threadId,
		runId,
		status: result?.approval ? "pending_approval" : "done",
		text: result?.text,
		private: result?.private,
		silent: result?.silent,
		approval: result?.approval,
		attachments: result?.attachments,
	};
}

function statusResponse(input: StatusResult): Record<string, unknown> {
	return input;
}

async function body(req: IncomingMessage, maxBytes: number): Promise<WebhookMessage> {
	const chunks: Buffer[] = [];
	let total = 0;
	for await (const chunk of req) {
		const next = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
		total += next.byteLength;
		if (total > maxBytes) throw new WebhookHttpError(413, "body too large");
		chunks.push(next);
	}
	if (!chunks.length) return {};
	let parsed: unknown;
	try {
		parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
	} catch {
		throw new WebhookHttpError(400, "invalid json body");
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new WebhookHttpError(400, "body must be an object");
	}
	return parsed as WebhookMessage;
}

function assertReplyUrl(input: string, hosts: string[] | undefined): void {
	let url: URL;
	try {
		url = new URL(input);
	} catch {
		throw new WebhookHttpError(400, "invalid replyUrl");
	}
	if (url.protocol !== "https:" && url.protocol !== "http:") throw new WebhookHttpError(400, "invalid replyUrl");
	if (!hosts?.length || !hosts.includes(url.hostname)) {
		throw new WebhookHttpError(400, "replyUrl host is not allowed");
	}
}

class WebhookHttpError extends Error {
	constructor(
		readonly status: number,
		message: string,
	) {
		super(message);
	}
}

function authorized(req: IncomingMessage, secret: string): boolean {
	const auth = req.headers.authorization;
	const bearer = auth?.startsWith("Bearer ") ? auth.slice("Bearer ".length) : undefined;
	const header = req.headers["x-heypi-secret"];
	const value = bearer ?? (Array.isArray(header) ? header[0] : header);
	return typeof value === "string" && safeEqual(value, secret);
}

function safeEqual(a: string, b: string): boolean {
	const left = Buffer.from(a);
	const right = Buffer.from(b);
	return left.length === right.length && timingSafeEqual(left, right);
}

function normalizePath(path: string): string {
	const value = `/${path.trim().replace(/^\/+|\/+$/g, "")}`;
	return value === "/" ? "" : value;
}

function escapeRe(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function wait(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function json(res: ServerResponse, status: number, body: Record<string, unknown>): void {
	res.writeHead(status, { "content-type": "application/json" });
	res.end(JSON.stringify(body));
}

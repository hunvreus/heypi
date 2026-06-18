import { randomBytes, randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { message } from "../core/log.js";
import type { Adapter, AdapterStart, Outbound, StatusResult } from "./handler.js";

export type LocalConfig = {
	name?: string;
	path?: string;
	host?: string;
	maxBodyBytes?: number;
	syncTimeoutMs?: number;
};

export type LocalMessage = {
	threadId?: string;
	user?: string;
	text?: string;
	sync?: boolean;
	timeoutMs?: number;
	data?: unknown;
};

const LOCAL_CONFIG_KEYS = new Set(["name", "path", "host", "maxBodyBytes", "syncTimeoutMs"]);

/** Creates a loopback-only local adapter for dev/admin testing. */
export function local(config: LocalConfig = {}): Adapter {
	warnUnknownConfig(config);
	const name = config.name ?? "local";
	const kind = "local";
	const base = normalizePath(config.path ?? "/dev");
	const maxBodyBytes = config.maxBodyBytes ?? 1_000_000;

	return {
		name,
		kind,
		async start(input) {
			if (!input.http) throw new Error("local adapter requires the heypi HTTP registrar");
			if (config.host && !loopbackHost(config.host)) {
				throw new Error("local adapter host must be loopback-only");
			}
			for (const [method, path] of [
				["POST", `${base}/messages`],
				["POST", `${base}/threads/:threadId/messages`],
				["GET", `${base}/threads/:threadId/runs/:runId`],
			] as const) {
				input.http.register({
					method,
					path,
					host: config.host,
					handler: (req, res) => route({ req, res, start: input, name, kind, base, maxBodyBytes, config }),
				});
			}
			input.logger.info("local.start", { adapter: name, kind, path: base, auth: "loopback" });
		},
	};
}

async function route(input: {
	req: IncomingMessage;
	res: ServerResponse;
	start: AdapterStart;
	name: string;
	kind: string;
	base: string;
	maxBodyBytes: number;
	config: LocalConfig;
}): Promise<void> {
	try {
		const url = new URL(input.req.url ?? "/", "http://localhost");
		const path = normalizePath(url.pathname);
		if (input.req.method === "POST" && path === `${input.base}/messages`) {
			return await receive(input, await body(input.req, input.maxBodyBytes), undefined);
		}
		const threadMatch = path.match(new RegExp(`^${escapeRe(input.base)}/threads/([^/]+)/messages$`));
		if (input.req.method === "POST" && threadMatch) {
			return await receive(input, await body(input.req, input.maxBodyBytes), decodeURIComponent(threadMatch[1]));
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
		if (error instanceof LocalHttpError) return json(input.res, error.status, { ok: false, error: error.message });
		input.start.logger.warn("local.error", { adapter: input.name, error: message(error) });
		return json(input.res, 500, { ok: false, error: "local adapter failed" });
	}
}

async function receive(
	input: {
		res: ServerResponse;
		start: AdapterStart;
		name: string;
		kind: string;
		config: LocalConfig;
	},
	payload: LocalMessage,
	threadFromRoute: string | undefined,
): Promise<void> {
	const text = payload.text?.trim();
	if (!text) return json(input.res, 400, { ok: false, error: "text is required" });
	const suppliedThreadId = payload.threadId?.trim();
	if (!threadFromRoute && suppliedThreadId?.startsWith("lcth_")) {
		return json(input.res, 400, { ok: false, error: "threadId uses a reserved prefix" });
	}
	const threadId = threadFromRoute ?? suppliedThreadId ?? `lcth_${randomBytes(18).toString("base64url")}`;
	const runId = randomUUID();
	const done = execute(input, payload, threadId, runId);
	if (payload.sync) {
		const timeoutMs = Math.min(Math.max(payload.timeoutMs ?? input.config.syncTimeoutMs ?? 25_000, 1), 30_000);
		const result = await Promise.race([done, wait(timeoutMs).then(() => undefined)]);
		return json(input.res, result ? 200 : 202, result ?? runningResponse(threadId, runId));
	}
	json(input.res, 202, runningResponse(threadId, runId));
}

async function execute(
	input: { name: string; kind: string; start: AdapterStart },
	payload: LocalMessage,
	threadId: string,
	runId: string,
): Promise<Record<string, unknown>> {
	try {
		const result = await input.start.handler({
			provider: input.name,
			kind: input.kind,
			eventId: runId,
			channel: threadId,
			actor: payload.user ?? "local",
			thread: threadId,
			text: payload.text ?? "",
			data: payload.data,
			trace: runId,
		});
		return outboundResponse(threadId, runId, result);
	} catch (error) {
		return { ok: false, threadId, runId, status: "failed", error: message(error) };
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

async function body(req: IncomingMessage, maxBytes: number): Promise<LocalMessage> {
	const chunks: Buffer[] = [];
	let total = 0;
	for await (const chunk of req) {
		const next = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
		total += next.byteLength;
		if (total > maxBytes) throw new LocalHttpError(413, "body too large");
		chunks.push(next);
	}
	if (!chunks.length) return {};
	let parsed: unknown;
	try {
		parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
	} catch {
		throw new LocalHttpError(400, "invalid json body");
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new LocalHttpError(400, "body must be an object");
	}
	return parsed as LocalMessage;
}

class LocalHttpError extends Error {
	constructor(
		readonly status: number,
		message: string,
	) {
		super(message);
	}
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

function loopbackHost(host: string): boolean {
	return host === "localhost" || host === "127.0.0.1" || host === "::1";
}

function warnUnknownConfig(config: LocalConfig): void {
	for (const key of Object.keys(config)) {
		if (!LOCAL_CONFIG_KEYS.has(key)) throw new Error(`unknown local adapter option: ${key}`);
	}
}

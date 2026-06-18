import { randomBytes, randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { message } from "../core/log.js";
import type { Adapter, AdapterStart } from "./handler.js";
import {
	escapeRe,
	HttpMessageError,
	json,
	normalizeMessagePath,
	outboundResponse,
	readJsonBody,
	runningResponse,
	statusResponse,
	wait,
} from "./http-message.js";

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
	const base = normalizeMessagePath(config.path ?? "/dev");
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
		const path = normalizeMessagePath(url.pathname);
		if (input.req.method === "POST" && path === `${input.base}/messages`) {
			return await receive(input, await readJsonBody<LocalMessage>(input.req, input.maxBodyBytes), undefined);
		}
		const threadMatch = path.match(new RegExp(`^${escapeRe(input.base)}/threads/([^/]+)/messages$`));
		if (input.req.method === "POST" && threadMatch) {
			return await receive(
				input,
				await readJsonBody<LocalMessage>(input.req, input.maxBodyBytes),
				decodeURIComponent(threadMatch[1]),
			);
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
		if (error instanceof HttpMessageError) return json(input.res, error.status, { ok: false, error: error.message });
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

function loopbackHost(host: string): boolean {
	return host === "localhost" || host === "127.0.0.1" || host === "::1";
}

function warnUnknownConfig(config: LocalConfig): void {
	for (const key of Object.keys(config)) {
		if (!LOCAL_CONFIG_KEYS.has(key)) throw new Error(`unknown local adapter option: ${key}`);
	}
}

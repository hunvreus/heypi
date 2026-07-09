import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { join } from "node:path";
import { listAuditChannels, readAuditChannel } from "./audit.js";
import type { ChatJob } from "./events.js";
import type { AdminConfig } from "./types.js";

export type AdminServer = {
	start(): Promise<void>;
	stop(): Promise<void>;
	url(): string;
};

export type CancelJobs = (
	scope: "active" | "queued" | "all",
	reason?: string,
) => Promise<{ active: number; queued: number }>;

function sendJson(response: ServerResponse, status: number, body: unknown): void {
	response.writeHead(status, { "content-type": "application/json" });
	response.end(JSON.stringify(body));
}

function joinUrl(base: string, suffix: string): string {
	const left = base.endsWith("/") ? base.slice(0, -1) : base;
	const right = suffix.startsWith("/") ? suffix : `/${suffix}`;
	return `${left}${right}`;
}

function channelKey(pathname: string, base: string): string | undefined {
	const prefix = joinUrl(base, "/channels/");
	if (!pathname.startsWith(prefix)) return undefined;
	const key = decodeURIComponent(pathname.slice(prefix.length));
	return /^[a-zA-Z0-9_.:-]+$/.test(key) ? key : undefined;
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
	const chunks: Uint8Array[] = [];
	for await (const chunk of request) chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
	const text = Buffer.concat(chunks).toString("utf8");
	if (!text) return {};
	const value = JSON.parse(text) as unknown;
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function cancelScope(value: unknown): "active" | "queued" | "all" {
	if (value === "active" || value === "queued" || value === "all") return value;
	return "all";
}

export function createAdmin(
	config: AdminConfig & { stateDir: string; jobs?: () => ChatJob[]; cancel?: CancelJobs },
): AdminServer {
	const host = config.host ?? "127.0.0.1";
	const port = config.port ?? 4321;
	const path = config.path ?? "/admin";
	let server: Server | undefined;

	return {
		async start() {
			server = createServer(async (request, response) => {
				if (!request.url) return sendJson(response, 404, { error: "not_found" });
				const url = new URL(request.url, `http://${host}:${port}`);
				if (request.method === "POST" && url.pathname === joinUrl(path, "/jobs/cancel")) {
					if (!config.cancel) return sendJson(response, 404, { error: "not_found" });
					const body = await readJson(request);
					const reason = typeof body.reason === "string" ? body.reason : undefined;
					const canceled = await config.cancel(cancelScope(body.scope), reason);
					return sendJson(response, 200, { canceled });
				}
				if (request.method !== "GET") return sendJson(response, 404, { error: "not_found" });
				if (url.pathname === path) {
					return sendJson(response, 200, {
						ok: true,
						endpoints: {
							health: joinUrl(path, "/health"),
							jobs: joinUrl(path, "/jobs"),
							cancelJobs: joinUrl(path, "/jobs/cancel"),
							channels: joinUrl(path, "/channels"),
						},
					});
				}
				if (url.pathname === joinUrl(path, "/health")) return sendJson(response, 200, { ok: true });
				if (url.pathname === joinUrl(path, "/jobs"))
					return sendJson(response, 200, { jobs: config.jobs?.() ?? [] });
				if (url.pathname === joinUrl(path, "/channels")) {
					const channels = await listAuditChannels({ stateDir: config.stateDir });
					return sendJson(response, 200, { channels: channels.map(({ key }) => key) });
				}
				const key = channelKey(url.pathname, path);
				if (key) {
					const records = await readAuditChannel(join(config.stateDir, "channels", `${key}.jsonl`));
					return sendJson(response, 200, { key, records });
				}
				return sendJson(response, 404, { error: "not_found" });
			});
			await new Promise<void>((resolve, reject) => {
				server?.once("error", reject);
				server?.listen(port, host, resolve);
			});
		},
		async stop() {
			if (!server) return;
			await new Promise<void>((resolve, reject) => {
				server?.close((error) => (error ? reject(error) : resolve()));
			});
			server = undefined;
		},
		url() {
			return `http://${host}:${port}${path}`;
		},
	};
}

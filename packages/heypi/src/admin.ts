import { createServer, type Server, type ServerResponse } from "node:http";
import { join } from "node:path";
import { listAuditChannels, readAuditChannel } from "./audit.js";
import type { AdminConfig } from "./types.js";

export type AdminServer = {
	start(): Promise<void>;
	stop(): Promise<void>;
	url(): string;
};

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

export function createAdmin(config: AdminConfig & { stateDir: string }): AdminServer {
	const host = config.host ?? "127.0.0.1";
	const port = config.port ?? 4321;
	const path = config.path ?? "/admin";
	let server: Server | undefined;

	return {
		async start() {
			server = createServer(async (request, response) => {
				if (request.method !== "GET" || !request.url) return sendJson(response, 404, { error: "not_found" });
				const url = new URL(request.url, `http://${host}:${port}`);
				if (url.pathname === joinUrl(path, "/health")) return sendJson(response, 200, { ok: true });
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

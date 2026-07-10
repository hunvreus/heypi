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

function sendHtml(response: ServerResponse, status: number, body: string): void {
	response.writeHead(status, { "content-type": "text/html; charset=utf-8" });
	response.end(body);
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

function isLoopback(host: string): boolean {
	return host === "127.0.0.1" || host === "::1" || host === "localhost";
}

function wantsHtml(request: IncomingMessage): boolean {
	const accept = request.headers.accept;
	return typeof accept === "string" && accept.includes("text/html");
}

function authorized(request: IncomingMessage, token: string | undefined): boolean {
	if (!token) return true;
	const auth = request.headers.authorization;
	if (auth === `Bearer ${token}`) return true;
	const header = request.headers["x-heypi-admin-token"];
	return header === token;
}

function escapeHtml(value: string): string {
	return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

function adminHtml(path: string, jobs: ChatJob[], channels: string[]): string {
	const jobRows =
		jobs
			.map(
				(job) => `<tr>
					<td>${escapeHtml(job.state)}</td>
					<td>${escapeHtml(job.adapter)}</td>
					<td>${escapeHtml(job.conversation)}</td>
					<td>${escapeHtml(job.thread ?? "")}</td>
					<td>${escapeHtml(job.actor.name ?? job.actor.id)}</td>
				</tr>`,
			)
			.join("") || `<tr><td colspan="5">No active jobs</td></tr>`;
	const channelRows =
		channels
			.map((channel) => {
				const href = joinUrl(path, `/channels/${encodeURIComponent(channel)}`);
				return `<li><a href="${href}">${escapeHtml(channel)}</a></li>`;
			})
			.join("") || "<li>No channels</li>";
	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>heypi admin</title>
<style>
body{font-family:system-ui,sans-serif;margin:32px;line-height:1.4;color:#111;background:#fafafa}
main{max-width:960px}
table{border-collapse:collapse;width:100%;background:white}
th,td{border:1px solid #ddd;padding:8px;text-align:left}
th{background:#f0f0f0}
button{margin-right:8px;padding:6px 10px}
code{background:#eee;padding:2px 4px}
</style>
</head>
<body>
<main>
<h1>heypi admin</h1>
<section>
<h2>Jobs</h2>
<p>
<button data-scope="active">Cancel active</button>
<button data-scope="queued">Cancel queued</button>
<button data-scope="all">Cancel all</button>
</p>
<table>
<thead><tr><th>State</th><th>Adapter</th><th>Conversation</th><th>Thread</th><th>Actor</th></tr></thead>
<tbody>${jobRows}</tbody>
</table>
</section>
<section>
<h2>Channels</h2>
<ul>${channelRows}</ul>
</section>
<p><a href="${joinUrl(path, "/jobs")}">Jobs JSON</a> · <a href="${joinUrl(path, "/channels")}">Channels JSON</a></p>
</main>
<script>
for (const button of document.querySelectorAll("button[data-scope]")) {
	button.addEventListener("click", async () => {
		await fetch(${JSON.stringify(joinUrl(path, "/jobs/cancel"))}, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ scope: button.dataset.scope, reason: "admin canceled" }),
		});
		location.reload();
	});
}
</script>
</body>
</html>`;
}

export function createAdmin(
	config: AdminConfig & { stateDir: string; jobs?: () => ChatJob[]; cancel?: CancelJobs },
): AdminServer {
	const host = config.host ?? "127.0.0.1";
	const port = config.port ?? 4321;
	const path = config.path ?? "/admin";
	const token = config.token?.trim();
	let server: Server | undefined;

	return {
		async start() {
			if (!isLoopback(host) && !token) throw new Error("Admin token is required for non-loopback hosts");
			server = createServer(async (request, response) => {
				if (!request.url) return sendJson(response, 404, { error: "not_found" });
				const url = new URL(request.url, `http://${host}:${port}`);
				if (!authorized(request, token)) return sendJson(response, 401, { error: "unauthorized" });
				if (request.method === "POST" && url.pathname === joinUrl(path, "/jobs/cancel")) {
					if (!config.cancel) return sendJson(response, 404, { error: "not_found" });
					const body = await readJson(request);
					const reason = typeof body.reason === "string" ? body.reason : undefined;
					const canceled = await config.cancel(cancelScope(body.scope), reason);
					return sendJson(response, 200, { canceled });
				}
				if (request.method !== "GET") return sendJson(response, 404, { error: "not_found" });
				if (url.pathname === path) {
					if (wantsHtml(request)) {
						const channels = await listAuditChannels({ stateDir: config.stateDir });
						return sendHtml(
							response,
							200,
							adminHtml(
								path,
								config.jobs?.() ?? [],
								channels.map(({ key }) => key),
							),
						);
					}
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

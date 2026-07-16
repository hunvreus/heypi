import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { listAuditConversations, listAuditPiSessions, readAuditConversationKey, readAuditPiSession } from "./audit.js";
import type { ChatJob } from "./events.js";
import type { ScheduleRun } from "./schedule-store.js";
import type { ScheduleInfo } from "./scheduler.js";
import type { AdminConfig } from "./types.js";

const MAX_BODY_BYTES = 1_000_000;

export type AdminServer = {
	start(): Promise<void>;
	stop(): Promise<void>;
	url(): string;
};

export type CancelJobs = (
	scope: "active" | "queued" | "all",
	reason?: string,
) => Promise<{ active: number; queued: number }>;

export type SecretAdmin = {
	pageHtml(): string;
	accept(reply: string): Promise<{ name: string } | undefined>;
};

export type ScheduleAdmin = {
	list(): ScheduleInfo[];
	run(id: string): Promise<ScheduleRun>;
};

function sendJson(response: ServerResponse, status: number, body: unknown): void {
	response.writeHead(status, { "content-type": "application/json" });
	response.end(JSON.stringify(body));
}

function sendCors(response: ServerResponse): void {
	response.writeHead(204, {
		"access-control-allow-origin": "*",
		"access-control-allow-methods": "POST, OPTIONS",
		"access-control-allow-headers": "content-type",
	});
	response.end();
}

function sendCorsJson(response: ServerResponse, status: number, body: unknown): void {
	response.writeHead(status, {
		"content-type": "application/json",
		"access-control-allow-origin": "*",
	});
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

function conversationKey(pathname: string, base: string): string | undefined {
	const prefix = joinUrl(base, "/conversations/");
	if (!pathname.startsWith(prefix)) return undefined;
	let key: string;
	try {
		key = decodeURIComponent(pathname.slice(prefix.length));
	} catch {
		return undefined;
	}
	return /^[a-zA-Z0-9_.:/-]+$/.test(key) ? key : undefined;
}

function piSessionKey(pathname: string, base: string): { key: string; id?: string } | undefined {
	const prefix = joinUrl(base, "/pi-sessions/");
	if (!pathname.startsWith(prefix)) return undefined;
	const parts = pathname.slice(prefix.length).split("/");
	if (parts.length < 1 || !parts[0]) return undefined;
	try {
		const key = decodeURIComponent(parts[0]);
		const id = parts[1] ? decodeURIComponent(parts.slice(1).join("/")) : undefined;
		if (!/^[a-zA-Z0-9_.:/-]+$/.test(key)) return undefined;
		if (id !== undefined && !/^[a-zA-Z0-9_.:/-]+$/.test(id)) return undefined;
		return { key, id };
	} catch {
		return undefined;
	}
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
	const chunks: Uint8Array[] = [];
	let bytes = 0;
	for await (const chunk of request) {
		const data = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
		bytes += data.byteLength;
		if (bytes > MAX_BODY_BYTES) throw new Error("request body too large");
		chunks.push(data);
	}
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

function secureCompare(left: string, right: string): boolean {
	const leftBuffer = Buffer.from(left);
	const rightBuffer = Buffer.from(right);
	return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function hostAllowed(request: IncomingMessage, host: string, port: number): boolean {
	if (!hostHeaderAllowed(request, host, port)) return false;
	const allowed = new Set([`${host}:${port}`, host]);
	const origin = request.headers.origin;
	if (typeof origin !== "string") return true;
	try {
		return allowed.has(new URL(origin).host);
	} catch {
		return false;
	}
}

function hostHeaderAllowed(request: IncomingMessage, host: string, port: number): boolean {
	const allowed = new Set([`${host}:${port}`, host]);
	const header = request.headers.host;
	return typeof header !== "string" || allowed.has(header);
}

function authorized(request: IncomingMessage, token: string | undefined): boolean {
	if (!token) return true;
	const auth = request.headers.authorization;
	if (typeof auth === "string" && secureCompare(auth, `Bearer ${token}`)) return true;
	const header = request.headers["x-heypi-admin-token"];
	return typeof header === "string" && secureCompare(header, token);
}

function escapeHtml(value: string): string {
	return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

function adminHtml(
	path: string,
	jobs: ChatJob[],
	conversations: string[],
	schedules: ScheduleInfo[],
	token?: string,
): string {
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
		conversations
			.map((conversation) => {
				const href = joinUrl(path, `/conversations/${encodeURIComponent(conversation)}`);
				const pi = joinUrl(path, `/pi-sessions/${encodeURIComponent(conversation)}`);
				return `<li><a href="${href}">${escapeHtml(conversation)}</a> · <a href="${pi}">Pi sessions</a></li>`;
			})
			.join("") || "<li>No conversations</li>";
	const scheduleRows =
		schedules
			.map(
				(schedule) => `<tr>
					<td>${escapeHtml(schedule.id)}</td>
					<td><code>${escapeHtml(schedule.cron)}</code></td>
					<td>${escapeHtml(schedule.timezone)}</td>
					<td>${escapeHtml(schedule.nextRun ?? "")}</td>
					<td><button data-schedule=${JSON.stringify(schedule.id)}>Run</button></td>
				</tr>`,
			)
			.join("") || `<tr><td colspan="5">No schedules</td></tr>`;
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
<h2>Schedules</h2>
<table>
<thead><tr><th>ID</th><th>Cron</th><th>Timezone</th><th>Next run</th><th></th></tr></thead>
<tbody>${scheduleRows}</tbody>
</table>
</section>
<section>
<h2>Conversations</h2>
<ul>${channelRows}</ul>
</section>
<p><a href="${joinUrl(path, "/jobs")}">Jobs JSON</a> · <a href="${joinUrl(path, "/conversations")}">Conversations JSON</a></p>
</main>
<script>
for (const button of document.querySelectorAll("button[data-scope]")) {
	button.addEventListener("click", async () => {
		await fetch(${JSON.stringify(joinUrl(path, "/jobs/cancel"))}, {
			method: "POST",
			headers: { "content-type": "application/json"${token ? `, "x-heypi-admin-token": ${JSON.stringify(token)}` : ""} },
			body: JSON.stringify({ scope: button.dataset.scope, reason: "admin canceled" }),
		});
		location.reload();
	});
}
for (const button of document.querySelectorAll("button[data-schedule]")) {
	button.addEventListener("click", async () => {
		await fetch(${JSON.stringify(joinUrl(path, "/schedules/run"))}, {
			method: "POST",
			headers: { "content-type": "application/json"${token ? `, "x-heypi-admin-token": ${JSON.stringify(token)}` : ""} },
			body: JSON.stringify({ id: button.dataset.schedule }),
		});
		location.reload();
	});
}
</script>
</body>
</html>`;
}

export function createAdmin(
	config: AdminConfig & {
		stateDir: string;
		jobs?: () => ChatJob[];
		cancel?: CancelJobs;
		secret?: SecretAdmin;
		schedules?: ScheduleAdmin;
	},
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
				try {
					if (!request.url) return sendJson(response, 404, { error: "not_found" });
					const url = new URL(request.url, `http://${host}:${port}`);
					if (config.secret && url.pathname === joinUrl(path, "/secret")) {
						if (!hostHeaderAllowed(request, host, port)) return sendJson(response, 403, { error: "forbidden" });
						if (request.method === "OPTIONS") return sendCors(response);
						if (request.method === "GET") return sendHtml(response, 200, config.secret.pageHtml());
						if (request.method === "POST") {
							const body = await readJson(request);
							if (typeof body.reply !== "string") return sendCorsJson(response, 400, { error: "missing_reply" });
							const stored = await config.secret.accept(body.reply);
							if (!stored) return sendCorsJson(response, 404, { error: "secret_request_not_found" });
							return sendCorsJson(response, 200, { ok: true, name: stored.name });
						}
					}
					if (!hostAllowed(request, host, port)) return sendJson(response, 403, { error: "forbidden" });
					if (!authorized(request, token)) return sendJson(response, 401, { error: "unauthorized" });
					if (request.method === "POST" && url.pathname === joinUrl(path, "/jobs/cancel")) {
						if (!config.cancel) return sendJson(response, 404, { error: "not_found" });
						const body = await readJson(request);
						const reason = typeof body.reason === "string" ? body.reason : undefined;
						const canceled = await config.cancel(cancelScope(body.scope), reason);
						return sendJson(response, 200, { canceled });
					}
					if (request.method === "POST" && url.pathname === joinUrl(path, "/schedules/run")) {
						if (!config.schedules) return sendJson(response, 404, { error: "not_found" });
						const body = await readJson(request);
						if (typeof body.id !== "string") return sendJson(response, 400, { error: "missing_id" });
						const run = await config.schedules.run(body.id);
						return sendJson(response, 202, { run });
					}
					if (request.method !== "GET") return sendJson(response, 404, { error: "not_found" });
					if (url.pathname === path) {
						if (wantsHtml(request)) {
							const conversations = await listAuditConversations({ stateDir: config.stateDir });
							return sendHtml(
								response,
								200,
								adminHtml(
									path,
									config.jobs?.() ?? [],
									conversations.map(({ key }) => key),
									config.schedules?.list() ?? [],
									token,
								),
							);
						}
						return sendJson(response, 200, {
							ok: true,
							endpoints: {
								health: joinUrl(path, "/health"),
								jobs: joinUrl(path, "/jobs"),
								cancelJobs: joinUrl(path, "/jobs/cancel"),
								schedules: config.schedules ? joinUrl(path, "/schedules") : undefined,
								runSchedule: config.schedules ? joinUrl(path, "/schedules/run") : undefined,
								conversations: joinUrl(path, "/conversations"),
								piSessions: joinUrl(path, "/pi-sessions/{conversation}"),
								secret: config.secret ? joinUrl(path, "/secret") : undefined,
							},
						});
					}
					if (url.pathname === joinUrl(path, "/health")) return sendJson(response, 200, { ok: true });
					if (url.pathname === joinUrl(path, "/jobs"))
						return sendJson(response, 200, { jobs: config.jobs?.() ?? [] });
					if (url.pathname === joinUrl(path, "/schedules"))
						return sendJson(response, 200, { schedules: config.schedules?.list() ?? [] });
					if (url.pathname === joinUrl(path, "/conversations")) {
						const conversations = await listAuditConversations({ stateDir: config.stateDir });
						return sendJson(response, 200, { conversations: conversations.map(({ key }) => key) });
					}
					const piSession = piSessionKey(url.pathname, path);
					if (piSession) {
						if (piSession.id === undefined) {
							const sessions = await listAuditPiSessions({ stateDir: config.stateDir }, piSession.key);
							if (!sessions) return sendJson(response, 404, { error: "not_found" });
							return sendJson(response, 200, {
								key: piSession.key,
								sessions: sessions.map((session) => ({
									id: session.id,
									url: joinUrl(
										path,
										`/pi-sessions/${encodeURIComponent(piSession.key)}/${encodeURIComponent(session.id)}`,
									),
								})),
							});
						}
						const text = await readAuditPiSession({ stateDir: config.stateDir }, piSession.key, piSession.id);
						if (text === undefined) return sendJson(response, 404, { error: "not_found" });
						response.writeHead(200, { "content-type": "application/jsonl; charset=utf-8" });
						response.end(text);
						return;
					}
					const key = conversationKey(url.pathname, path);
					if (key) {
						const records = await readAuditConversationKey({ stateDir: config.stateDir }, key);
						if (!records) return sendJson(response, 404, { error: "not_found" });
						return sendJson(response, 200, { key, records });
					}
					return sendJson(response, 404, { error: "not_found" });
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					const status = message.includes("JSON") || message.includes("too large") ? 400 : 500;
					return sendJson(response, status, { error: status === 400 ? "bad_request" : "server_error" });
				}
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

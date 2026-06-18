import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { hostname } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { message } from "../core/log.js";
import type { Adapter, AdapterStart } from "../io/handler.js";
import {
	adminLoginUrl,
	canonicalStateRoot,
	createAdminLoginToken,
	ensureAdminSecret,
	removeAdminServerDescriptor,
	removeStaleAdminServerDescriptors,
	verifyAdminLoginToken,
	writeAdminServerDescriptor,
} from "./auth.js";
import { type AdminOverview, type AdminService, createAdminService } from "./service.js";
import {
	approvalsView,
	configurationView,
	errorPage,
	evalsView,
	jobsView,
	loginPage,
	memoryView,
	page,
	threadsView,
} from "./view.js";

export type AdminConfig = {
	auth?: boolean;
	secret?: string;
	loginTtlMs?: number;
	sessionTtlMs?: number;
	idleTtlMs?: number;
	secureCookies?: boolean;
};

export type AdminHttpConfig = {
	host: string;
	port: number | string;
};

export type AdminStateConfig = {
	root: string;
	agent: string;
	project: string;
};

type Session = {
	hash: string;
	csrf: string;
	expiresAt: number;
	idleExpiresAt: number;
};

type AdminLoginLink = {
	url: string;
	expiresAt: number;
};

type AdminState = {
	auth: boolean;
	host: string;
	port: number | string;
	instanceId: string;
	secretHash?: string;
	signingSecret?: string;
	loginTtlMs: number;
	sessionTtlMs: number;
	idleTtlMs: number;
	secureCookies: boolean;
	usedLoginJtis: Map<string, number>;
	sessions: Map<string, Session>;
	failures: Map<string, number[]>;
	service: AdminService;
	start: AdapterStart;
	stateRoot: string;
	agent: string;
	project: string;
};

const ADMIN_PATH = "/admin";
const COOKIE = "heypi_admin";
const DEFAULT_LOGIN_TTL_MS = 5 * 60_000;
const DEFAULT_SESSION_TTL_MS = 8 * 60 * 60_000;
const DEFAULT_IDLE_TTL_MS = 60 * 60_000;
const MAX_FORM_BYTES = 16_384;
const LOGIN_WINDOW_MS = 60_000;
const MAX_LOGIN_FAILURES = 10;
const CONFIG_REDIRECTS = new Set(["/admin/access", "/admin/routes", "/admin/adapters", "/admin/summary"]);
const CHAT_REDIRECTS = new Set(["/admin/threads", "/admin/activity", "/admin/runs", "/admin/calls"]);

const ADMIN_ROUTES = [
	["GET", "/admin"],
	["GET", "/admin/login"],
	["POST", "/admin/login"],
	["POST", "/admin/logout"],
	["POST", "/admin/messages"],
	["GET", "/admin/activity"],
	["GET", "/admin/approvals"],
	["GET", "/admin/configuration"],
	["GET", "/admin/evals"],
	["GET", "/admin/jobs"],
	["GET", "/admin/memory"],
	["GET", "/admin/summary"],
	["GET", "/admin/threads/:id"],
	["GET", "/admin/events"],
	["GET", "/admin/assets/admin.css"],
	["GET", "/admin/assets/basecoat.all.min.js"],
	["GET", "/admin/adapters"],
	["GET", "/admin/threads"],
	["GET", "/admin/runs"],
	["GET", "/admin/calls"],
	["GET", "/admin/_pulse"],
	["*", "/admin/*"],
] as const;

/** Creates the internal read-only admin HTTP surface served under `/admin/*`. */
export function createAdminAdapter(config: AdminConfig, http: AdminHttpConfig, stateConfig: AdminStateConfig): Adapter {
	const host = http.host;
	const port = http.port;
	const auth = config.auth !== false;
	const loginTtlMs = config.loginTtlMs ?? DEFAULT_LOGIN_TTL_MS;
	const sessionTtlMs = config.sessionTtlMs ?? DEFAULT_SESSION_TTL_MS;
	const idleTtlMs = config.idleTtlMs ?? DEFAULT_IDLE_TTL_MS;
	const secretHash = config.secret ? hash(config.secret) : undefined;
	const secureCookies = config.secureCookies === true;
	const usedLoginJtis = new Map<string, number>();
	const sessions = new Map<string, Session>();
	const failures = new Map<string, number[]>();
	const instanceId = randomToken(16);
	let start: AdapterStart | undefined;
	let state: AdminState | undefined;

	return {
		name: "admin",
		kind: "admin",
		async start(input): Promise<void> {
			if (!input.http) throw new Error("admin requires the heypi HTTP registrar");
			const stateRoot = canonicalStateRoot(stateConfig.root);
			const signingSecret = auth ? (config.secret ?? ensureAdminSecret(stateRoot)) : undefined;
			assertAdminConfig({ auth, host, secret: config.secret, secureCookies, signingSecret });
			start = input;
			state = {
				auth,
				host,
				port,
				instanceId,
				secretHash,
				signingSecret,
				loginTtlMs,
				sessionTtlMs,
				idleTtlMs,
				secureCookies,
				usedLoginJtis,
				sessions,
				failures,
				service: createAdminService(input),
				start: input,
				stateRoot,
				agent: stateConfig.agent,
				project: stateConfig.project,
			};
			const current = state;
			for (const [method, path] of ADMIN_ROUTES) {
				input.http.register({
					method,
					path,
					host,
					port,
					reserved: true,
					handler: (req, res) => handle(req, res, current),
				});
			}
			input.logger.info("admin.start", {
				host,
				port,
				path: ADMIN_PATH,
				auth: auth ? (secretHash ? "secret" : "local-link") : "disabled",
				stateRoot,
			});
		},
		async ready(input): Promise<void> {
			if (!state) return;
			const address = input.http?.address?.();
			if (address) {
				state.host = address.host;
				state.port = address.port;
			}
			if (!state.auth) return;
			removeStaleAdminServerDescriptors(state.stateRoot);
			writeAdminServerDescriptor(state.stateRoot, {
				version: 1,
				pid: process.pid,
				instanceId: state.instanceId,
				hostname: hostname(),
				url: adminUrl(state.host, state.port),
				agent: state.agent,
				project: state.project,
				startedAt: new Date(state.start.app?.startedAt ?? Date.now()).toISOString(),
				adminPath: ADMIN_PATH,
			});
			if (!state.secretHash && loopbackHost(state.host)) {
				const link = mintLoginLink(state);
				input.logger.warn("admin.login_link", {
					url: link.url,
					expiresInMs: loginTtlMs,
				});
			}
		},
		async stop(): Promise<void> {
			start?.logger.info("admin.stop", { path: ADMIN_PATH });
			if (state?.auth) removeAdminServerDescriptor(state.stateRoot);
			usedLoginJtis.clear();
			sessions.clear();
			failures.clear();
			start = undefined;
			state = undefined;
		},
	};
}

async function handle(req: IncomingMessage, res: ServerResponse, state: AdminState): Promise<void> {
	const nonce = randomToken(16);
	securityHeaders(res, nonce, state.instanceId);
	try {
		cleanup(state);
		const url = new URL(req.url ?? ADMIN_PATH, "http://localhost");
		const method = req.method ?? "GET";
		if (method === "GET" && url.pathname === "/admin/assets/admin.css") return css(res, 200, loadAdminCss());
		if (method === "GET" && url.pathname === "/admin/assets/basecoat.all.min.js") {
			return javascript(res, 200, loadAdminJs());
		}
		if (!state.auth) return await handleWithoutAuth(req, res, state, nonce, url, method);
		if (method === "GET" && url.pathname === "/admin/login") {
			return await loginGet(req, res, state, url, nonce);
		}
		if (method === "POST" && url.pathname === "/admin/login") {
			return await loginPost(req, res, state, nonce);
		}
		const session = currentSession(req, state);
		if (!session) return redirect(res, "/admin/login");
		if (method === "POST" && url.pathname === "/admin/logout") {
			await requireCsrf(req, session);
			state.sessions.delete(session.hash);
			return redirect(res, "/admin/login", [clearCookie(state)]);
		}
		return await handleAdminRoute(req, res, state, session, nonce, url, method);
	} catch (error) {
		if (error instanceof AdminHttpError) {
			return adminError(res, error.status, errorTitle(error.status), errorMessage(error), nonce);
		}
		state.start.logger.warn("admin.error", { error: message(error) });
		return adminError(
			res,
			500,
			"Admin route failed",
			"The admin panel could not complete this request. Check the heypi process logs for details.",
			nonce,
		);
	}
}

async function handleWithoutAuth(
	req: IncomingMessage,
	res: ServerResponse,
	state: AdminState,
	nonce: string,
	url: URL,
	method: string,
): Promise<void> {
	if (method === "GET" && url.pathname === "/admin/login") return redirect(res, "/admin");
	if (method === "POST" && (url.pathname === "/admin/login" || url.pathname === "/admin/logout")) {
		return redirect(res, "/admin");
	}
	return await handleAdminRoute(req, res, state, { csrf: "" }, nonce, url, method);
}

async function handleAdminRoute(
	req: IncomingMessage,
	res: ServerResponse,
	state: AdminState,
	session: { csrf: string },
	nonce: string,
	url: URL,
	method: string,
): Promise<void> {
	if (method === "POST" && url.pathname === "/admin/messages") {
		return await postMessage(req, res, state, session);
	}
	if (method !== "GET") {
		return adminError(res, 405, "Method not allowed", "This admin route does not accept that HTTP method.", nonce);
	}
	if (url.pathname === "/admin/events") return await events(req, res, state);
	if (url.pathname === "/admin/_pulse") return await pulse(res, state);
	return await routePage(res, state, session, nonce, url);
}

async function postMessage(
	req: IncomingMessage,
	res: ServerResponse,
	state: AdminState,
	session: { csrf: string },
): Promise<void> {
	const form = await requireCsrf(req, session);
	const text = formValue(form, "text").trim();
	const threadId = formValue(form, "threadId").trim();
	const actor = formValue(form, "actor").trim();
	if (!text) throw new AdminHttpError(400, "Message text is required.");
	const result = await state.service.sendMessage({
		text,
		threadId: threadId || undefined,
		actor: actor || undefined,
	});
	redirect(res, `/admin/threads/${encodeURIComponent(result.threadId)}`);
}

async function loginGet(
	req: IncomingMessage,
	res: ServerResponse,
	state: AdminState,
	url: URL,
	nonce: string,
): Promise<void> {
	const session = currentSession(req, state);
	if (session) return redirect(res, "/admin");
	const token = url.searchParams.get("t");
	if (token) {
		if (!consumeLoginToken(state, token)) {
			return html(
				res,
				401,
				loginPage({ error: "Invalid or expired login link.", secret: state.secretHash !== undefined, nonce }),
			);
		}
		return issueSession(res, state);
	}
	return html(res, 200, loginPage({ secret: state.secretHash !== undefined, nonce }));
}

async function loginPost(req: IncomingMessage, res: ServerResponse, state: AdminState, nonce: string): Promise<void> {
	if (!state.secretHash)
		return html(res, 400, loginPage({ error: "Secret login is not enabled.", secret: false, nonce }));
	if (!sameOrigin(req)) throw new AdminHttpError(403, "forbidden");
	const key = req.socket.remoteAddress ?? "unknown";
	if (rateLimited(state.failures, key)) throw new AdminHttpError(429, "too many login attempts");
	const form = await formBody(req);
	const secret = form.get("secret");
	if (typeof secret !== "string" || !safeHashEqual(hash(secret), state.secretHash)) {
		recordFailure(state.failures, key);
		return html(res, 401, loginPage({ error: "Invalid admin secret.", secret: true, nonce }));
	}
	state.failures.delete(key);
	return issueSession(res, state);
}

async function routePage(
	res: ServerResponse,
	state: AdminState,
	session: { csrf: string },
	nonce: string,
	url: URL,
): Promise<void> {
	const path = url.pathname;
	if (CONFIG_REDIRECTS.has(path)) return redirect(res, "/admin/configuration");
	if (CHAT_REDIRECTS.has(path)) return redirect(res, "/admin");
	const threadId = threadPathId(path);
	if (threadId) {
		const [overview, threads, thread] = await Promise.all([
			state.service.overview(),
			state.service.threads(pageInput(url)),
			state.service.thread(threadId, { event: stringParam(url.searchParams.get("event")) }),
		]);
		if (!thread) return adminError(res, 404, "Thread not found", "This admin thread does not exist.", nonce);
		return renderAdminPage(res, state, session, nonce, {
			title: "Thread",
			active: "chats",
			overview,
			livePage: true,
			liveThreadId: thread.thread.id,
			body: threadsView(threads, { checkedAt: overview.live.checkedAt, selected: thread, csrf: session.csrf }),
		});
	}
	if (path === "/admin") {
		const [overview, threads] = await Promise.all([state.service.overview(), state.service.threads(pageInput(url))]);
		return renderAdminPage(res, state, session, nonce, {
			title: "Chats",
			active: "chats",
			overview,
			livePage: true,
			body: threadsView(threads, { checkedAt: overview.live.checkedAt, csrf: session.csrf }),
		});
	}
	if (path === "/admin/configuration") {
		const overview = await state.service.overview();
		return renderAdminPage(res, state, session, nonce, {
			title: "Configuration",
			active: "configuration",
			overview,
			livePage: true,
			body: configurationView(overview, adminInfo(state)),
		});
	}
	if (path === "/admin/approvals") {
		const [overview, approvals] = await Promise.all([
			state.service.overview(),
			state.service.approvals(pageInput(url)),
		]);
		return renderAdminPage(res, state, session, nonce, {
			title: "Approvals",
			active: "approvals",
			overview,
			livePage: true,
			body: approvalsView(approvals, overview.live.checkedAt),
		});
	}
	if (path === "/admin/jobs") {
		const [overview, jobs] = await Promise.all([state.service.overview(), state.service.jobs(pageInput(url))]);
		return renderAdminPage(res, state, session, nonce, {
			title: "Jobs",
			active: "jobs",
			overview,
			livePage: true,
			body: jobsView(jobs, overview.live.checkedAt),
		});
	}
	if (path === "/admin/evals") {
		const [overview, evals] = await Promise.all([state.service.overview(), state.service.evals(pageInput(url))]);
		return renderAdminPage(res, state, session, nonce, {
			title: "Evals",
			active: "evals",
			overview,
			livePage: true,
			body: evalsView(evals, overview.live.checkedAt),
		});
	}
	if (path === "/admin/memory") {
		const [overview, memory] = await Promise.all([state.service.overview(), state.service.memory(pageInput(url))]);
		return renderAdminPage(res, state, session, nonce, {
			title: "Memory",
			active: "memory",
			overview,
			body: memoryView(memory, overview.live.checkedAt),
		});
	}
	return adminError(res, 404, "Page not found", "This admin page does not exist or has moved.", nonce);
}

function renderAdminPage(
	res: ServerResponse,
	state: AdminState,
	session: { csrf: string },
	nonce: string,
	input: {
		title: string;
		active: string;
		overview: AdminOverview;
		body: string;
		livePage?: boolean;
		liveThreadId?: string;
	},
): void {
	html(
		res,
		200,
		page({
			title: input.title,
			active: input.active,
			csrf: session.csrf,
			auth: state.auth,
			live: input.overview.live,
			memoryFiles: input.overview.memory.total,
			nonce,
			livePage: input.livePage,
			liveThreadId: input.liveThreadId,
			body: input.body,
		}),
	);
}

async function pulse(res: ServerResponse, state: AdminState): Promise<void> {
	const live = await state.service.live();
	return text(
		res,
		200,
		`Pulse: ${live.pendingApprovals} pending approvals | ${live.runningRuns} running runs | ${live.recentCalls} recent calls | ${new Date(live.checkedAt).toISOString()}`,
	);
}

async function events(req: IncomingMessage, res: ServerResponse, state: AdminState): Promise<void> {
	res.writeHead(200, {
		"content-type": "text/event-stream; charset=utf-8",
		"cache-control": "no-store",
		connection: "keep-alive",
	});
	let closed = false;
	let timer: ReturnType<typeof setTimeout> | undefined;
	const send = async (): Promise<void> => {
		if (closed) return;
		if (state.auth && !currentSession(req, state, { touch: false })) {
			closed = true;
			res.write('event: auth\ndata: {"ok":false}\n\n');
			res.end();
			return;
		}
		try {
			const live = await state.service.live();
			if (closed) return;
			res.write(`event: summary\ndata: ${JSON.stringify(live)}\n\n`);
		} catch (error) {
			state.start.logger.warn("admin.events_failed", { error: message(error) });
		}
	};
	const schedule = (): void => {
		if (closed) return;
		timer = setTimeout(() => {
			void send().finally(schedule);
		}, 3000);
		timer.unref?.();
	};
	req.on("close", () => {
		closed = true;
		if (timer) clearTimeout(timer);
	});
	await send();
	schedule();
}

function pageInput(url: URL): {
	limit: number;
	offset: number;
	q?: string;
	type?: string;
	state?: string;
	channel?: string;
	actor?: string;
	scope?: string;
} {
	return {
		limit: numberParam(url.searchParams.get("limit"), 25),
		offset: numberParam(url.searchParams.get("offset"), 0),
		q: stringParam(url.searchParams.get("q")),
		type: stringParam(url.searchParams.get("type")),
		state: stringParam(url.searchParams.get("state")),
		channel: stringParam(url.searchParams.get("channel")),
		actor: stringParam(url.searchParams.get("actor")),
		scope: stringParam(url.searchParams.get("scope")),
	};
}

function numberParam(input: string | null, fallback: number): number {
	if (!input) return fallback;
	const parsed = Number(input);
	return Number.isFinite(parsed) ? parsed : fallback;
}

function stringParam(input: string | null): string | undefined {
	const value = input?.trim();
	return value ? value : undefined;
}

function threadPathId(path: string): string | undefined {
	const prefix = "/admin/threads/";
	if (!path.startsWith(prefix)) return undefined;
	const id = path.slice(prefix.length).trim();
	if (!id) return undefined;
	try {
		return decodeURIComponent(id);
	} catch {
		return undefined;
	}
}

function mintLoginLink(state: AdminState): AdminLoginLink {
	if (!state.signingSecret) throw new Error("admin signing secret is unavailable");
	const token = createAdminLoginToken(state.signingSecret, state.loginTtlMs, { stateRoot: state.stateRoot });
	return { url: adminLoginUrl(adminUrl(state.host, state.port), token.token, ADMIN_PATH), expiresAt: token.expiresAt };
}

function adminInfo(state: AdminState): {
	host: string;
	port: number | string;
} {
	return {
		host: state.host,
		port: state.port,
	};
}

function issueSession(res: ServerResponse, state: AdminState): void {
	const token = randomToken();
	const now = Date.now();
	const session: Session = {
		hash: hash(token),
		csrf: randomToken(),
		expiresAt: now + state.sessionTtlMs,
		idleExpiresAt: now + state.idleTtlMs,
	};
	state.sessions.set(session.hash, session);
	redirect(res, "/admin", [sessionCookie(state, token)]);
}

function currentSession(
	req: IncomingMessage,
	state: AdminState,
	options: { touch?: boolean } = {},
): Session | undefined {
	const token = cookie(req, COOKIE);
	if (!token) return undefined;
	const key = hash(token);
	const session = state.sessions.get(key);
	if (!session) return undefined;
	const now = Date.now();
	if (session.expiresAt <= now || session.idleExpiresAt <= now) {
		state.sessions.delete(key);
		return undefined;
	}
	if (options.touch !== false) session.idleExpiresAt = Math.min(session.expiresAt, now + state.idleTtlMs);
	return session;
}

async function requireCsrf(req: IncomingMessage, session: { csrf: string }): Promise<URLSearchParams> {
	if (!sameOrigin(req)) throw new AdminHttpError(403, "forbidden");
	const form = await formBody(req);
	const header = headerValue(req.headers["x-csrf-token"]);
	const token = header ?? form.get("csrf");
	if (typeof token !== "string" || !safeTextEqual(token, session.csrf)) {
		throw new AdminHttpError(403, "forbidden");
	}
	return form;
}

function consumeLoginToken(state: AdminState, token: string): boolean {
	if (!state.signingSecret) return false;
	const result = verifyAdminLoginToken(state.signingSecret, token, { stateRoot: state.stateRoot });
	if (!result.ok) return false;
	if (state.usedLoginJtis.has(result.payload.jti)) return false;
	state.usedLoginJtis.set(result.payload.jti, result.payload.exp);
	return true;
}

async function formBody(req: IncomingMessage): Promise<URLSearchParams> {
	const chunks: Buffer[] = [];
	let total = 0;
	for await (const chunk of req) {
		const next = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
		total += next.byteLength;
		if (total > MAX_FORM_BYTES) throw new AdminHttpError(413, "body too large");
		chunks.push(next);
	}
	return new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
}

function formValue(form: URLSearchParams, key: string): string {
	const value = form.get(key);
	return typeof value === "string" ? value : "";
}

function cleanup(state: AdminState): void {
	const now = Date.now();
	for (const [key, expiresAt] of state.usedLoginJtis) {
		if (expiresAt <= now) state.usedLoginJtis.delete(key);
	}
	for (const [key, row] of state.sessions) {
		if (row.expiresAt <= now || row.idleExpiresAt <= now) state.sessions.delete(key);
	}
	for (const [key, rows] of state.failures) {
		const active = rows.filter((time) => now - time <= LOGIN_WINDOW_MS);
		if (active.length) state.failures.set(key, active);
		else state.failures.delete(key);
	}
}

function rateLimited(failures: Map<string, number[]>, key: string): boolean {
	const now = Date.now();
	const rows = (failures.get(key) ?? []).filter((time) => now - time <= LOGIN_WINDOW_MS);
	failures.set(key, rows);
	return rows.length >= MAX_LOGIN_FAILURES;
}

function recordFailure(failures: Map<string, number[]>, key: string): void {
	const now = Date.now();
	const rows = (failures.get(key) ?? []).filter((time) => now - time <= LOGIN_WINDOW_MS);
	rows.push(now);
	failures.set(key, rows);
}

function sessionCookie(state: AdminState, token: string): string {
	return cookieText(`${COOKIE}=${token}`, [
		"Path=/admin",
		"HttpOnly",
		"SameSite=Lax",
		`Max-Age=${Math.ceil(state.sessionTtlMs / 1000)}`,
		state.secureCookies ? "Secure" : undefined,
	]);
}

function clearCookie(state: AdminState): string {
	return cookieText(`${COOKIE}=`, [
		"Path=/admin",
		"HttpOnly",
		"SameSite=Lax",
		"Max-Age=0",
		state.secureCookies ? "Secure" : undefined,
	]);
}

function cookieText(value: string, attrs: Array<string | undefined>): string {
	return [value, ...attrs.filter((attr): attr is string => attr !== undefined)].join("; ");
}

function cookie(req: IncomingMessage, name: string): string | undefined {
	const raw = req.headers.cookie;
	if (!raw) return undefined;
	for (const part of raw.split(";")) {
		const index = part.indexOf("=");
		if (index < 0) continue;
		const key = part.slice(0, index).trim();
		if (key === name) return part.slice(index + 1).trim();
	}
	return undefined;
}

function sameOrigin(req: IncomingMessage): boolean {
	const host = req.headers.host;
	// Non-browser or HTTP/1.0-style clients may omit all origin headers; CSRF tokens still gate unsafe actions.
	if (!host) return true;
	const expected = host.toLowerCase();
	const origin = headerValue(req.headers.origin);
	if (origin) return originHost(origin)?.toLowerCase() === expected;
	const referer = headerValue(req.headers.referer);
	if (referer) return originHost(referer)?.toLowerCase() === expected;
	// Same-origin is enforced when a browser sends origin metadata.
	return true;
}

function originHost(input: string): string | undefined {
	try {
		return new URL(input).host;
	} catch {
		return undefined;
	}
}

function headerValue(input: string | string[] | undefined): string | undefined {
	return Array.isArray(input) ? input[0] : input;
}

function redirect(res: ServerResponse, location: string, cookies: string[] = []): void {
	if (cookies.length) res.setHeader("set-cookie", cookies);
	res.writeHead(303, { location });
	res.end();
}

function html(res: ServerResponse, status: number, body: string): void {
	res.writeHead(status, { "content-type": "text/html; charset=utf-8" });
	res.end(body);
}

function adminError(res: ServerResponse, status: number, title: string, body: string, nonce: string): void {
	html(res, status, errorPage({ title, message: body, status, nonce }));
}

function errorTitle(status: number): string {
	if (status === 403) return "Forbidden";
	if (status === 413) return "Request too large";
	if (status === 429) return "Too many attempts";
	if (status === 405) return "Method not allowed";
	return "Admin request failed";
}

function errorMessage(error: AdminHttpError): string {
	if (error.status === 403) return "This request was blocked by the admin security checks.";
	if (error.status === 413) return "The submitted admin request body is too large.";
	if (error.status === 429) return "Too many failed login attempts. Wait a minute and try again.";
	if (error.message) return error.message;
	return "The admin panel could not complete this request.";
}

function text(res: ServerResponse, status: number, body: string): void {
	res.writeHead(status, { "content-type": "text/plain; charset=utf-8" });
	res.end(body);
}

function css(res: ServerResponse, status: number, body: string): void {
	res.writeHead(status, { "content-type": "text/css; charset=utf-8", "cache-control": "no-store" });
	res.end(body);
}

function javascript(res: ServerResponse, status: number, body: string): void {
	res.writeHead(status, { "content-type": "application/javascript; charset=utf-8", "cache-control": "no-store" });
	res.end(body);
}

function securityHeaders(res: ServerResponse, nonce: string, instanceId: string): void {
	res.setHeader("cache-control", "no-store");
	res.setHeader(
		"content-security-policy",
		`default-src 'self'; script-src 'self' 'nonce-${nonce}'; connect-src 'self'; style-src 'self' 'nonce-${nonce}'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'`,
	);
	res.setHeader("permissions-policy", "camera=(), microphone=(), geolocation=()");
	res.setHeader("referrer-policy", "no-referrer");
	res.setHeader("x-heypi-admin-instance", instanceId);
	res.setHeader("x-content-type-options", "nosniff");
	res.setHeader("x-frame-options", "DENY");
}

function assertAdminConfig(input: {
	auth: boolean;
	host: string;
	secret?: string;
	secureCookies: boolean;
	signingSecret?: string;
}): void {
	if (!input.auth) {
		if (!loopbackHost(input.host)) throw new Error("admin auth can only be disabled on loopback hosts");
		return;
	}
	if (!loopbackHost(input.host) && !input.secureCookies) {
		throw new Error("admin secureCookies must be enabled for non-loopback hosts");
	}
	if (input.secret && !strongSecret(input.secret))
		throw new Error("admin secret must be at least 32 varied characters");
	if (!input.signingSecret || !strongSecret(input.signingSecret)) {
		throw new Error("admin signing secret must be at least 32 varied characters");
	}
}

function strongSecret(input: string): boolean {
	return Buffer.byteLength(input, "utf8") >= 32 && new Set(input).size >= 8;
}

function loopbackHost(host: string): boolean {
	const normalized = host.toLowerCase().replace(/^\[/u, "").replace(/\]$/u, "");
	return normalized === "localhost" || normalized === "127.0.0.1" || normalized === "::1";
}

function urlHost(host: string): string {
	if (host === "0.0.0.0") return "127.0.0.1";
	if (host === "::") return "[::1]";
	return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
}

function adminUrl(host: string, port: number | string): string {
	return `http://${urlHost(host)}:${port}`;
}

function randomToken(bytes = 32): string {
	return randomBytes(bytes).toString("base64url");
}

function hash(input: string): string {
	return createHash("sha256").update(input).digest("hex");
}

function safeHashEqual(left: string, right: string): boolean {
	return timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
}

function safeTextEqual(left: string, right: string): boolean {
	const leftBuffer = Buffer.from(left);
	const rightBuffer = Buffer.from(right);
	return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

class AdminHttpError extends Error {
	constructor(
		readonly status: number,
		message: string,
	) {
		super(message);
	}
}

function loadAdminCss(): string {
	// Re-read CSS so dev:admin-css updates are visible without restarting heypi.
	return loadAdminAsset(
		undefined,
		[
			["assets", "admin.css"],
			["..", "..", "dist", "admin", "assets", "admin.css"],
		],
		"admin CSS asset missing; run `pnpm run build:admin-css` or `pnpm run build`",
	);
}

let adminJs: string | undefined;

function loadAdminJs(): string {
	adminJs = loadAdminAsset(
		adminJs,
		[
			["assets", "basecoat.all.min.js"],
			["..", "..", "dist", "admin", "assets", "basecoat.all.min.js"],
			["..", "..", "node_modules", "basecoat-css", "dist", "js", "all.min.js"],
		],
		"admin JS asset missing; run `pnpm run build:admin-css` or `pnpm run build`",
	);
	return adminJs;
}

function loadAdminAsset(cached: string | undefined, candidates: string[][], missingMessage: string): string {
	if (cached) return cached;
	const here = dirname(fileURLToPath(import.meta.url));
	for (const segments of candidates) {
		const path = join(here, ...segments);
		if (existsSync(path)) {
			return readFileSync(path, "utf8");
		}
	}
	throw new Error(missingMessage);
}

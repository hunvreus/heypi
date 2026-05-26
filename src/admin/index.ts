import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { message } from "../core/log.js";
import type { Adapter, AdapterStart } from "../io/handler.js";
import { DEFAULT_ADMIN_CONTROL_PATH, ensureAdminControl } from "./control.js";
import { type AdminService, createAdminService } from "./service.js";
import { activityView, approvalsView, errorPage, jobsView, loginPage, memoryView, overviewView, page } from "./view.js";

export type AdminConfig = {
	auth?: boolean;
	secret?: string;
	controlPath?: string;
	loginTtlMs?: number;
	sessionTtlMs?: number;
	idleTtlMs?: number;
	secureCookies?: boolean;
};

export type AdminHttpConfig = {
	host: string;
	port: number | string;
};

type LoginToken = {
	expiresAt: number;
	used: boolean;
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
	secretHash?: string;
	loginTtlMs: number;
	sessionTtlMs: number;
	idleTtlMs: number;
	secureCookies: boolean;
	controlHash: string;
	loginTokens: Map<string, LoginToken>;
	sessions: Map<string, Session>;
	failures: Map<string, number[]>;
	service: AdminService;
	start: AdapterStart;
};

const ADMIN_PATH = "/admin";
const COOKIE = "heypi_admin";
const DEFAULT_LOGIN_TTL_MS = 5 * 60_000;
const DEFAULT_SESSION_TTL_MS = 8 * 60 * 60_000;
const DEFAULT_IDLE_TTL_MS = 60 * 60_000;
const MAX_FORM_BYTES = 16_384;
const LOGIN_WINDOW_MS = 60_000;
const MAX_LOGIN_FAILURES = 10;
let adminCss: string | undefined;

const ADMIN_ROUTES = [
	["GET", "/admin"],
	["GET", "/admin/login"],
	["POST", "/admin/login"],
	["POST", "/admin/logout"],
	["GET", "/admin/activity"],
	["GET", "/admin/approvals"],
	["GET", "/admin/jobs"],
	["GET", "/admin/memory"],
	["GET", "/admin/events"],
	["GET", "/admin/assets/admin.css"],
	["GET", "/admin/assets/basecoat.all.min.js"],
	["POST", "/admin/_control/links"],
	["GET", "/admin/adapters"],
	["GET", "/admin/threads"],
	["GET", "/admin/runs"],
	["GET", "/admin/calls"],
	["GET", "/admin/_pulse"],
	["*", "/admin/*"],
] as const;

/** Creates the internal read-only admin HTTP surface served under `/admin/*`. */
export function createAdminAdapter(config: AdminConfig, http: AdminHttpConfig): Adapter {
	const host = http.host;
	const port = http.port;
	const auth = config.auth !== false;
	const loginTtlMs = config.loginTtlMs ?? DEFAULT_LOGIN_TTL_MS;
	const sessionTtlMs = config.sessionTtlMs ?? DEFAULT_SESSION_TTL_MS;
	const idleTtlMs = config.idleTtlMs ?? DEFAULT_IDLE_TTL_MS;
	const secretHash = config.secret ? hash(config.secret) : undefined;
	const secureCookies = config.secureCookies === true;
	const loginTokens = new Map<string, LoginToken>();
	const sessions = new Map<string, Session>();
	const failures = new Map<string, number[]>();
	let start: AdapterStart | undefined;

	return {
		name: "admin",
		kind: "admin",
		async start(input): Promise<void> {
			if (!input.http) throw new Error("admin requires the heypi HTTP registrar");
			const controlPath = config.controlPath ?? DEFAULT_ADMIN_CONTROL_PATH;
			const control = ensureAdminControl(controlPath, adminUrl(host, port));
			assertAdminConfig({ auth, host, secret: config.secret, controlToken: control.token });
			start = input;
			const state: AdminState = {
				auth,
				host,
				port,
				secretHash,
				loginTtlMs,
				sessionTtlMs,
				idleTtlMs,
				secureCookies,
				controlHash: hash(control.token),
				loginTokens,
				sessions,
				failures,
				service: createAdminService(input),
				start: input,
			};
			for (const [method, path] of ADMIN_ROUTES) {
				input.http.register({
					method,
					path,
					host,
					port,
					reserved: true,
					handler: (req, res) => handle(req, res, state),
				});
			}
			if (auth && !secretHash && loopbackHost(host)) {
				const link = mintLoginLink(state);
				input.logger.warn("admin.login_link", {
					url: link.url,
					expiresInMs: loginTtlMs,
				});
			}
			if (!loopbackHost(host) && !secureCookies) {
				input.logger.warn("admin.cookie_not_secure", { host, port });
			}
			input.logger.info("admin.start", {
				host,
				port,
				path: ADMIN_PATH,
				auth: auth ? (secretHash ? "secret" : "local-link") : "disabled",
				controlPath,
			});
		},
		async stop(): Promise<void> {
			start?.logger.info("admin.stop", { path: ADMIN_PATH });
			loginTokens.clear();
			sessions.clear();
			failures.clear();
			start = undefined;
		},
	};
}

async function handle(req: IncomingMessage, res: ServerResponse, state: AdminState): Promise<void> {
	const nonce = randomToken(16);
	securityHeaders(res, nonce);
	try {
		cleanup(state);
		const url = new URL(req.url ?? ADMIN_PATH, "http://localhost");
		const method = req.method ?? "GET";
		if (method === "GET" && url.pathname === "/admin/assets/admin.css") return css(res, 200, loadAdminCss());
		if (method === "GET" && url.pathname === "/admin/assets/basecoat.all.min.js") {
			return javascript(res, 200, loadAdminJs());
		}
		if (method === "POST" && url.pathname === "/admin/_control/links") {
			return controlLink(req, res, state);
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
		return await handleReadRoute(req, res, state, session, nonce, url, method);
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
	return await handleReadRoute(req, res, state, { csrf: "" }, nonce, url, method);
}

async function handleReadRoute(
	req: IncomingMessage,
	res: ServerResponse,
	state: AdminState,
	session: { csrf: string },
	nonce: string,
	url: URL,
	method: string,
): Promise<void> {
	if (method !== "GET")
		return adminError(res, 405, "Method not allowed", "This admin route does not accept that HTTP method.", nonce);
	if (url.pathname === "/admin/events") return await events(req, res, state);
	if (url.pathname === "/admin/_pulse") return await pulse(res, state);
	return await routePage(res, state, session, nonce, url);
}

function controlLink(req: IncomingMessage, res: ServerResponse, state: AdminState): void {
	const token = bearer(req);
	if (!token || !safeHashEqual(hash(token), state.controlHash)) {
		json(res, 401, { error: "unauthorized" });
		return;
	}
	const link = mintLoginLink(state);
	state.start.logger.warn("admin.login_link", { url: link.url, expiresInMs: state.loginTtlMs, source: "cli" });
	json(res, 200, link);
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
	const token = url.searchParams.get("token");
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
	if (path === "/admin/access" || path === "/admin/routes" || path === "/admin/adapters")
		return redirect(res, "/admin/configuration");
	if (path === "/admin/threads" || path === "/admin/runs" || path === "/admin/calls") {
		return redirect(res, "/admin");
	}
	if (path === "/admin" || path === "/admin/activity") {
		const [overview, activity] = await Promise.all([
			state.service.overview(),
			state.service.activity(pageInput(url)),
		]);
		return html(
			res,
			200,
			page({
				title: "Activity",
				active: "activity",
				csrf: session.csrf,
				auth: state.auth,
				live: overview.live,
				memoryFiles: overview.memory.total,
				nonce,
				livePage: true,
				body: activityView(activity, overview.live.checkedAt),
			}),
		);
	}
	if (path === "/admin/configuration" || path === "/admin/summary") {
		const overview = await state.service.overview();
		return html(
			res,
			200,
			page({
				title: "Configuration",
				active: "configuration",
				csrf: session.csrf,
				auth: state.auth,
				live: overview.live,
				memoryFiles: overview.memory.total,
				nonce,
				livePage: true,
				body: overviewView(overview, adminInfo(state)),
			}),
		);
	}
	if (path === "/admin/approvals") {
		const [overview, approvals] = await Promise.all([
			state.service.overview(),
			state.service.approvals(pageInput(url)),
		]);
		return html(
			res,
			200,
			page({
				title: "Approvals",
				active: "approvals",
				csrf: session.csrf,
				auth: state.auth,
				live: overview.live,
				memoryFiles: overview.memory.total,
				nonce,
				livePage: true,
				body: approvalsView(approvals, overview.live.checkedAt),
			}),
		);
	}
	if (path === "/admin/jobs") {
		const [overview, jobs] = await Promise.all([state.service.overview(), state.service.jobs(pageInput(url))]);
		return html(
			res,
			200,
			page({
				title: "Jobs",
				active: "jobs",
				csrf: session.csrf,
				auth: state.auth,
				live: overview.live,
				memoryFiles: overview.memory.total,
				nonce,
				livePage: true,
				body: jobsView(jobs, overview.live.checkedAt),
			}),
		);
	}
	if (path === "/admin/memory") {
		const [overview, memory] = await Promise.all([state.service.overview(), state.service.memory(pageInput(url))]);
		return html(
			res,
			200,
			page({
				title: "Memory",
				active: "memory",
				csrf: session.csrf,
				auth: state.auth,
				live: overview.live,
				memoryFiles: overview.memory.total,
				nonce,
				body: memoryView(memory, overview.live.checkedAt),
			}),
		);
	}
	return adminError(res, 404, "Page not found", "This admin page does not exist or has moved.", nonce);
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
	let timer: ReturnType<typeof setInterval> | undefined;
	const send = async (): Promise<void> => {
		if (closed) return;
		try {
			const live = await state.service.live();
			res.write(`event: summary\ndata: ${JSON.stringify(live)}\n\n`);
		} catch (error) {
			state.start.logger.warn("admin.events_failed", { error: message(error) });
		}
	};
	req.on("close", () => {
		closed = true;
		if (timer) clearInterval(timer);
	});
	timer = setInterval(() => void send(), 3000);
	timer.unref?.();
	await send();
}

function pageInput(url: URL): { limit: number; offset: number } {
	return {
		limit: numberParam(url.searchParams.get("limit"), 25),
		offset: numberParam(url.searchParams.get("offset"), 0),
	};
}

function numberParam(input: string | null, fallback: number): number {
	if (!input) return fallback;
	const parsed = Number(input);
	return Number.isFinite(parsed) ? parsed : fallback;
}

function mintLoginLink(state: AdminState): AdminLoginLink {
	const token = randomToken();
	const expiresAt = Date.now() + state.loginTtlMs;
	state.loginTokens.set(hash(token), { expiresAt, used: false });
	return {
		url: `${adminUrl(state.host, state.port)}/admin/login?token=${encodeURIComponent(token)}`,
		expiresAt,
	};
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

function currentSession(req: IncomingMessage, state: AdminState): Session | undefined {
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
	session.idleExpiresAt = Math.min(session.expiresAt, now + state.idleTtlMs);
	return session;
}

async function requireCsrf(req: IncomingMessage, session: Session): Promise<URLSearchParams> {
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
	const key = hash(token);
	const row = state.loginTokens.get(key);
	if (!row || row.used || row.expiresAt <= Date.now()) return false;
	row.used = true;
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

function cleanup(state: AdminState): void {
	const now = Date.now();
	for (const [key, row] of state.loginTokens) {
		if (row.expiresAt <= now) state.loginTokens.delete(key);
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

function bearer(req: IncomingMessage): string | undefined {
	const raw = headerValue(req.headers.authorization);
	if (!raw?.startsWith("Bearer ")) return undefined;
	return raw.slice("Bearer ".length).trim();
}

function sameOrigin(req: IncomingMessage): boolean {
	const host = req.headers.host;
	if (!host) return true;
	const expected = host.toLowerCase();
	const origin = headerValue(req.headers.origin);
	if (origin) return originHost(origin)?.toLowerCase() === expected;
	const referer = headerValue(req.headers.referer);
	if (referer) return originHost(referer)?.toLowerCase() === expected;
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

function json(res: ServerResponse, status: number, body: unknown): void {
	res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
	res.end(JSON.stringify(body));
}

function css(res: ServerResponse, status: number, body: string): void {
	res.writeHead(status, { "content-type": "text/css; charset=utf-8", "cache-control": "no-store" });
	res.end(body);
}

function javascript(res: ServerResponse, status: number, body: string): void {
	res.writeHead(status, { "content-type": "application/javascript; charset=utf-8", "cache-control": "no-store" });
	res.end(body);
}

function securityHeaders(res: ServerResponse, nonce: string): void {
	res.setHeader("cache-control", "no-store");
	res.setHeader(
		"content-security-policy",
		`default-src 'self'; script-src 'self' 'nonce-${nonce}'; connect-src 'self'; style-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'`,
	);
	res.setHeader("permissions-policy", "camera=(), microphone=(), geolocation=()");
	res.setHeader("referrer-policy", "no-referrer");
	res.setHeader("x-content-type-options", "nosniff");
	res.setHeader("x-frame-options", "DENY");
}

function assertAdminConfig(input: { auth: boolean; host: string; secret?: string; controlToken: string }): void {
	if (!input.auth && !loopbackHost(input.host)) throw new Error("admin auth can only be disabled on loopback hosts");
	if (loopbackHost(input.host)) return;
	if (input.secret && !strongSecret(input.secret))
		throw new Error("admin secret must be at least 32 varied characters");
	if (!strongSecret(input.secret ?? input.controlToken)) {
		throw new Error("admin control token must be at least 32 varied characters");
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
	adminCss = loadAdminAsset(
		adminCss,
		[
			["assets", "admin.css"],
			["..", "..", "dist", "admin", "assets", "admin.css"],
		],
		"admin CSS asset missing; run `pnpm run build:admin-css` or `pnpm run build`",
	);
	return adminCss;
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

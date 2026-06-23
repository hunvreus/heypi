import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	realpathSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";

export type AdminServerDescriptor = {
	version: 1;
	pid: number;
	instanceId: string;
	hostname: string;
	url: string;
	agent: string;
	project: string;
	startedAt: string;
	adminPath: string;
	auth?: boolean;
};

type AdminLoginPayload = {
	v: 1;
	exp: number;
	jti: string;
	scope: string;
};

export type AdminLoginToken = {
	token: string;
	expiresAt: number;
	jti: string;
};

export type AdminLoginScope = {
	stateRoot: string;
};

const TOKEN_VERSION = 1;
const TOKEN_BODY_BYTES = 1 + 6 + 16 + 16;
const TOKEN_SIG_BYTES = 32;

export function adminDir(stateRoot: string): string {
	return join(stateRoot, "admin");
}

export function adminSecretPath(stateRoot: string): string {
	return join(adminDir(stateRoot), "secret");
}

export function adminCsrfPath(stateRoot: string): string {
	return join(adminDir(stateRoot), "csrf");
}

export function canonicalStateRoot(stateRoot: string): string {
	const path = resolve(stateRoot);
	try {
		return realpathSync.native(path);
	} catch {
		return path;
	}
}

export function ensureAdminSecret(stateRoot: string): string {
	const path = adminSecretPath(stateRoot);
	ensureAdminDir(stateRoot);
	if (existsSync(path)) return readAdminSecret(stateRoot);
	const secret = randomToken(32);
	try {
		writeFileSync(path, `${secret}\n`, { flag: "wx", mode: 0o600 });
	} catch (error) {
		if (errno(error) === "EEXIST") return readAdminSecret(stateRoot);
		throw error;
	}
	chmodSync(path, 0o600);
	assertPrivateFile(path, "admin secret");
	return secret;
}

export function ensureAdminCsrf(stateRoot: string): string {
	const path = adminCsrfPath(stateRoot);
	ensureAdminDir(stateRoot);
	if (existsSync(path)) return readAdminCsrf(stateRoot);
	const token = randomToken(32);
	try {
		writeFileSync(path, `${token}\n`, { flag: "wx", mode: 0o600 });
	} catch (error) {
		if (errno(error) === "EEXIST") return readAdminCsrf(stateRoot);
		throw error;
	}
	chmodSync(path, 0o600);
	assertPrivateFile(path, "admin csrf token");
	return token;
}

export function readAdminSecret(stateRoot: string): string {
	const path = adminSecretPath(stateRoot);
	prepareExistingAdminDir(stateRoot);
	assertPrivateFile(path, "admin secret");
	const secret = readFileSync(path, "utf8").trim();
	if (!strongSecret(secret)) throw new Error(`admin secret is invalid: ${path}`);
	return secret;
}

function readAdminCsrf(stateRoot: string): string {
	const path = adminCsrfPath(stateRoot);
	prepareExistingAdminDir(stateRoot);
	assertPrivateFile(path, "admin csrf token");
	const token = readFileSync(path, "utf8").trim();
	if (!strongSecret(token)) throw new Error(`admin csrf token is invalid: ${path}`);
	return token;
}

export function createAdminLoginToken(
	secret: string,
	ttlMs: number,
	scope: AdminLoginScope,
	now = Date.now(),
): AdminLoginToken {
	const expiresAt = now + ttlMs;
	const jti = randomBytes(16);
	const body = Buffer.alloc(TOKEN_BODY_BYTES);
	body[0] = TOKEN_VERSION;
	body.writeUIntBE(expiresAt, 1, 6);
	jti.copy(body, 7);
	scopeDigest(scope).copy(body, 23);
	const sig = signature(secret, body);
	return {
		token: Buffer.concat([body, sig]).toString("base64url"),
		expiresAt,
		jti: jti.toString("base64url"),
	};
}

export function adminLoginUrl(baseUrl: string, token: string, adminPath = "/admin"): string {
	const url = new URL(baseUrl);
	url.pathname = `${adminPath.replace(/\/+$/u, "")}/login`;
	url.search = "";
	url.hash = "";
	url.searchParams.set("t", token);
	return url.toString();
}

export function verifyAdminLoginToken(
	secret: string,
	token: string,
	scope: AdminLoginScope,
	now = Date.now(),
): { ok: true; payload: AdminLoginPayload } | { ok: false } {
	const raw = parseToken(token);
	if (!raw) return { ok: false };
	const body = raw.subarray(0, TOKEN_BODY_BYTES);
	const sig = raw.subarray(TOKEN_BODY_BYTES);
	if (!safeEqual(signature(secret, body), sig)) return { ok: false };
	if (body[0] !== TOKEN_VERSION) return { ok: false };
	const exp = body.readUIntBE(1, 6);
	if (exp <= now) return { ok: false };
	const scopeBytes = body.subarray(23, 39);
	if (!safeEqual(scopeDigest(scope), scopeBytes)) return { ok: false };
	const jti = body.subarray(7, 23).toString("base64url");
	return { ok: true, payload: { v: 1, exp, jti, scope: scopeBytes.toString("base64url") } };
}

export function serverDescriptorPath(stateRoot: string, pid = process.pid): string {
	return join(adminDir(stateRoot), `server.${pid}.json`);
}

export function writeAdminServerDescriptor(stateRoot: string, input: AdminServerDescriptor): string {
	ensureAdminDir(stateRoot);
	const path = serverDescriptorPath(stateRoot, input.pid);
	const tmp = `${path}.${randomToken(6)}.tmp`;
	writeFileSync(tmp, `${JSON.stringify(input, null, 2)}\n`, { mode: 0o600 });
	chmodSync(tmp, 0o600);
	renameSync(tmp, path);
	return path;
}

export function removeAdminServerDescriptor(stateRoot: string, pid = process.pid): void {
	rmSync(serverDescriptorPath(stateRoot, pid), { force: true });
}

export function readAdminServerDescriptors(
	stateRoot: string,
): Array<{ path: string; descriptor: AdminServerDescriptor }> {
	const dir = adminDir(stateRoot);
	if (!existsSync(dir)) return [];
	return readdirSync(dir)
		.filter((name) => /^server\.\d+\.json$/u.test(name))
		.flatMap((name) => {
			const path = join(dir, name);
			const descriptor = readAdminServerDescriptor(path);
			return descriptor ? [{ path, descriptor }] : [];
		});
}

export function removeStaleAdminServerDescriptors(stateRoot: string): void {
	for (const row of readAdminServerDescriptors(stateRoot)) {
		if (!processAlive(row.descriptor.pid)) rmSync(row.path, { force: true });
	}
}

export function processAlive(pid: number): boolean {
	if (!Number.isInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

function readAdminServerDescriptor(path: string): AdminServerDescriptor | undefined {
	try {
		const stat = statSync(path);
		if (!stat.isFile()) return undefined;
		const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<AdminServerDescriptor>;
		if (
			parsed.version !== 1 ||
			typeof parsed.pid !== "number" ||
			typeof parsed.instanceId !== "string" ||
			typeof parsed.hostname !== "string" ||
			typeof parsed.url !== "string" ||
			typeof parsed.agent !== "string" ||
			typeof parsed.project !== "string" ||
			typeof parsed.startedAt !== "string" ||
			typeof parsed.adminPath !== "string" ||
			("auth" in parsed && typeof parsed.auth !== "boolean")
		) {
			return undefined;
		}
		return parsed as AdminServerDescriptor;
	} catch {
		return undefined;
	}
}

function parseToken(input: string): Buffer | undefined {
	try {
		const raw = Buffer.from(input, "base64url");
		return raw.length === TOKEN_BODY_BYTES + TOKEN_SIG_BYTES ? raw : undefined;
	} catch {
		return undefined;
	}
}

function signature(secret: string, body: Buffer): Buffer {
	return createHmac("sha256", signingKey(secret)).update(body).digest();
}

function signingKey(secret: string): Buffer {
	return createHmac("sha256", secret).update("heypi-admin-login-v1").digest();
}

function scopeDigest(input: AdminLoginScope): Buffer {
	return createHash("sha256").update(canonicalStateRoot(input.stateRoot)).digest().subarray(0, 16);
}

function randomToken(bytes: number): string {
	return randomBytes(bytes).toString("base64url");
}

function safeEqual(left: Buffer, right: Buffer): boolean {
	return left.length === right.length && timingSafeEqual(left, right);
}

function strongSecret(input: string): boolean {
	return Buffer.byteLength(input, "utf8") >= 32 && new Set(input).size >= 8;
}

function assertPrivateFile(path: string, label: string): void {
	const stat = statSync(path);
	if (!stat.isFile()) throw new Error(`${label} is not a file: ${path}`);
	if (process.platform !== "win32" && (stat.mode & 0o077) !== 0) {
		throw new Error(`${label} must not be readable or writable by group/other: ${path}`);
	}
}

function ensureAdminDir(stateRoot: string): void {
	const path = adminDir(stateRoot);
	mkdirSync(path, { recursive: true, mode: 0o700 });
	privateDir(path);
	assertPrivateDir(path, "admin state directory");
}

function prepareExistingAdminDir(stateRoot: string): void {
	const path = adminDir(stateRoot);
	if (!existsSync(path)) return;
	privateDir(path);
	assertPrivateDir(path, "admin state directory");
}

function privateDir(path: string): void {
	if (process.platform !== "win32") chmodSync(path, 0o700);
}

function assertPrivateDir(path: string, label: string): void {
	const stat = statSync(path);
	if (!stat.isDirectory()) throw new Error(`${label} is not a directory: ${path}`);
	if (process.platform !== "win32" && (stat.mode & 0o077) !== 0) {
		throw new Error(`${label} must not be readable, writable, or executable by group/other: ${path}`);
	}
}

function errno(error: unknown): string | undefined {
	return typeof error === "object" && error !== null && "code" in error ? String(error.code) : undefined;
}

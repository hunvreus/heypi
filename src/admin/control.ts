import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export type AdminControl = {
	token: string;
	url: string;
	createdAt: string;
	updatedAt: string;
};

export const DEFAULT_ADMIN_CONTROL_PATH = ".heypi/admin-control.json";

export function ensureAdminControl(path: string | undefined, url: string): AdminControl {
	const target = path ?? DEFAULT_ADMIN_CONTROL_PATH;
	const existing = readAdminControlIfExists(target);
	const now = new Date().toISOString();
	const control: AdminControl = {
		token: existing?.token && strongToken(existing.token) ? existing.token : randomToken(),
		url,
		createdAt: existing?.createdAt ?? now,
		updatedAt: now,
	};
	writeAdminControl(target, control);
	return control;
}

export function readAdminControl(path = DEFAULT_ADMIN_CONTROL_PATH): AdminControl {
	const control = readAdminControlIfExists(path);
	if (!control) throw new Error(`admin control file not found: ${path}`);
	if (!strongToken(control.token)) throw new Error(`admin control file has an invalid token: ${path}`);
	if (!control.url) throw new Error(`admin control file has no URL: ${path}`);
	return control;
}

function readAdminControlIfExists(path: string): AdminControl | undefined {
	if (!existsSync(path)) return undefined;
	const raw = readFileSync(path, "utf8");
	const parsed = JSON.parse(raw) as Partial<AdminControl>;
	if (typeof parsed.token !== "string" || typeof parsed.url !== "string") return undefined;
	return {
		token: parsed.token,
		url: parsed.url,
		createdAt: typeof parsed.createdAt === "string" ? parsed.createdAt : new Date().toISOString(),
		updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : new Date().toISOString(),
	};
}

function writeAdminControl(path: string, control: AdminControl): void {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify(control, null, 2)}\n`, { mode: 0o600 });
	chmodSync(path, 0o600);
}

function randomToken(): string {
	return randomBytes(32).toString("base64url");
}

function strongToken(input: string): boolean {
	return Buffer.byteLength(input, "utf8") >= 32 && new Set(input).size >= 8;
}

import {
	constants,
	createDecipheriv,
	generateKeyPairSync,
	privateDecrypt,
	randomBytes,
	timingSafeEqual,
} from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { SecretsConfig } from "../config.js";
import type { ScopedKey } from "./scope.js";

const DEFAULT_URL = "https://heypi.dev/secret";
const DEFAULT_EXPIRES_IN_MS = 10 * 60_000;
const DEFAULT_MAX_FIELDS = 8;
const FIELD_RE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

export type NormalizedSecretsConfig = {
	enabled: boolean;
	url: string;
	serve: boolean;
	expiresInMs: number;
	maxFields: number;
};

export type SecretField = {
	name: string;
	label: string;
};

export type CompletedSecret = {
	id: string;
	files: SecretFile[];
};

export type SecretFile = {
	name: string;
	path: string;
	value: string;
};

export type SecretWriteTarget = {
	write?(input: { path: string; content: string }): Promise<{ path: string; bytes: number }>;
};

type PendingSecret = {
	id: string;
	scope: ScopedKey;
	actor: string;
	fields: SecretField[];
	privateKeyPem: string;
	expiresAt: number;
};

/**
 * Owns encrypted secret handoffs. Pending keys stay in process memory; completed values are
 * written only through the explicit runtime target passed to `save`.
 */
export class Secrets {
	private readonly pending = new Map<string, PendingSecret>();

	constructor(private readonly config: NormalizedSecretsConfig) {}

	enabled(): boolean {
		return this.config.enabled;
	}

	create(
		scope: ScopedKey,
		input: { reason: string; fields: Array<{ name: string; label?: string }>; actor: string },
	): {
		id: string;
		url: string;
		fields: SecretField[];
		expiresAt: number;
	} {
		if (!this.config.enabled) throw new Error("secret requests are disabled");
		const reason = normalizeReason(input.reason);
		const actor = normalizeActor(input.actor);
		const fields = normalizeFields(input.fields, this.config.maxFields);
		const { publicKey, privateKey } = generateKeyPairSync("rsa", {
			modulusLength: 2048,
			publicKeyEncoding: { type: "spki", format: "der" },
			privateKeyEncoding: { type: "pkcs8", format: "pem" },
		});
		const id = `sec_${Date.now().toString(36)}_${randomBytes(8).toString("hex")}`;
		const expiresAt = Date.now() + this.config.expiresInMs;
		this.pending.set(id, {
			id,
			scope,
			actor,
			fields,
			privateKeyPem: privateKey as string,
			expiresAt,
		});
		const payload = {
			v: 1,
			id,
			reason,
			fields,
			publicKey: (publicKey as Buffer).toString("base64"),
			alg: "RSA-OAEP-256+A256GCM",
		};
		const hash = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
		return { id, url: `${this.config.url}#${hash}`, fields, expiresAt };
	}

	complete(text: string, scope: ScopedKey, actor: string): CompletedSecret | undefined {
		const match = text.match(/\bheypi-secret:([^:\s]+):([A-Za-z0-9_-]+)/);
		if (!match) return undefined;
		const [, id, payload] = match;
		const pending = this.pending.get(id);
		if (!pending) return undefined;
		if (pending.expiresAt < Date.now()) {
			this.pending.delete(id);
			return undefined;
		}
		if (!sameScope(pending.scope, scope)) return undefined;
		const currentActor = actor.trim();
		if (!currentActor || !sameActor(pending.actor, currentActor)) return undefined;
		const values = decryptValues(pending, payload);
		this.pending.delete(id);
		return {
			id,
			files: pending.fields.map((field) => ({
				name: field.name,
				path: `.secrets/${field.name}`,
				value: values[field.name] ?? "",
			})),
		};
	}

	async save(secret: CompletedSecret, target: SecretWriteTarget | undefined): Promise<string[]> {
		const write = target?.write?.bind(target);
		if (!write) throw new Error("selected runtime does not support writing secret files");
		await Promise.all(secret.files.map((file) => write({ path: file.path, content: file.value })));
		return secret.files.map((file) => file.path);
	}
}

export function isSecretReply(text: string): boolean {
	return /\bheypi-secret:([^:\s]+):([A-Za-z0-9_-]+)/.test(text);
}

export function normalizeSecretsConfig(input: SecretsConfig | undefined): NormalizedSecretsConfig {
	if (input === true) {
		return {
			enabled: true,
			url: DEFAULT_URL,
			serve: false,
			expiresInMs: DEFAULT_EXPIRES_IN_MS,
			maxFields: DEFAULT_MAX_FIELDS,
		};
	}
	if (!input) {
		return {
			enabled: false,
			url: DEFAULT_URL,
			serve: false,
			expiresInMs: DEFAULT_EXPIRES_IN_MS,
			maxFields: DEFAULT_MAX_FIELDS,
		};
	}
	return {
		enabled: input.enabled ?? true,
		url: normalizeUrl(input.url ?? DEFAULT_URL),
		serve: input.serve ?? false,
		expiresInMs: input.expiresInMs ?? DEFAULT_EXPIRES_IN_MS,
		maxFields: input.maxFields ?? DEFAULT_MAX_FIELDS,
	};
}

export function secretPage(): string {
	return SECRET_PAGE;
}

export function secretCss(): string {
	return readFileSync(join(dirname(fileURLToPath(import.meta.url)), "assets", "secret.css"), "utf8");
}

function normalizeFields(input: Array<{ name: string; label?: string }>, maxFields: number): SecretField[] {
	if (!Array.isArray(input) || input.length === 0) throw new Error("at least one secret field is required");
	if (input.length > maxFields) throw new Error(`too many secret fields: ${input.length} > ${maxFields}`);
	const seen = new Set<string>();
	return input.map((field) => {
		const name = field.name.trim();
		if (!FIELD_RE.test(name)) throw new Error("secret field name must be an env-style identifier");
		if (seen.has(name)) throw new Error(`duplicate secret field: ${name}`);
		seen.add(name);
		const label = field.label?.trim() || name;
		if (label.length > 120) throw new Error("secret field label is too long");
		return { name, label };
	});
}

function normalizeReason(input: string): string {
	const reason = input.trim();
	if (!reason) throw new Error("secret request reason is required");
	if (reason.length > 500) throw new Error("secret request reason is too long");
	return reason;
}

function normalizeActor(input: string): string {
	const actor = input.trim();
	if (!actor) throw new Error("secret request actor is required");
	return actor;
}

function decryptValues(pending: PendingSecret, payload: string): Record<string, string> {
	const buf = Buffer.from(payload, "base64url");
	if (buf.length < 2 + 12 + 16) throw new Error("invalid secret payload");
	const keyLength = buf.readUInt16BE(0);
	if (keyLength <= 0 || buf.length < 2 + keyLength + 12 + 16) throw new Error("invalid secret payload");
	const encryptedKey = buf.subarray(2, 2 + keyLength);
	const rest = buf.subarray(2 + keyLength);
	const iv = rest.subarray(0, 12);
	const tag = rest.subarray(rest.length - 16);
	const ciphertext = rest.subarray(12, rest.length - 16);
	const aes = privateDecrypt(
		{ key: pending.privateKeyPem, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" },
		encryptedKey,
	);
	const decipher = createDecipheriv("aes-256-gcm", aes, iv);
	decipher.setAuthTag(tag);
	const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
	const parsed = JSON.parse(decrypted) as unknown;
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("invalid secret payload");
	const record = parsed as Record<string, unknown>;
	const out: Record<string, string> = {};
	for (const field of pending.fields) {
		const value = record[field.name];
		if (typeof value !== "string" || !value) throw new Error(`missing secret field: ${field.name}`);
		out[field.name] = value;
	}
	return out;
}

function sameScope(a: ScopedKey, b: ScopedKey): boolean {
	const left = Buffer.from(a.path);
	const right = Buffer.from(b.path);
	return left.length === right.length && timingSafeEqual(left, right);
}

function sameActor(a: string, b: string): boolean {
	const left = Buffer.from(a);
	const right = Buffer.from(b);
	return left.length === right.length && timingSafeEqual(left, right);
}

export function secretRoute(url: string): string {
	return new URL(url).pathname || "/";
}

export function secretStyleRoute(url: string): string {
	const route = secretRoute(url);
	if (route === "/") return "/secret.css";
	return `${route.replace(/\/$/, "")}.css`;
}

function normalizeUrl(input: string): string {
	const url = new URL(input);
	url.hash = "";
	if (url.protocol !== "https:" && url.hostname !== "localhost" && url.hostname !== "127.0.0.1") {
		throw new Error("secret url must use https outside localhost");
	}
	return url.toString().replace(/\/$/, "");
}

const SECRET_PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="content-security-policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'self'; base-uri 'none'; form-action 'none'">
<title>heypi secret</title>
<script>
(() => {
  const query = matchMedia('(prefers-color-scheme: dark)');
  const apply = (dark) => document.documentElement.classList.toggle('dark', dark);
  apply(query.matches);
  query.addEventListener?.('change', (event) => apply(event.matches));
})();
</script>
<link rel="stylesheet" href="secret.css">
</head>
<body class="min-h-screen bg-background text-foreground">
<main class="grid min-h-screen place-items-center p-6">
<section class="card w-full max-w-[34rem]">
<header>
<h2>Share secrets securely</h2>
<p class="text-muted-foreground">Fill in the requested values. This page encrypts them locally and gives you a reply to paste back into chat.</p>
</header>
<section>
<form id="form" class="grid gap-4"></form>
<section id="out" class="hidden mt-5 border-t pt-5">
<label for="blob" class="text-sm font-medium">Paste this into chat</label>
<textarea id="blob" class="textarea mt-2 min-h-32 font-mono text-[13px]" readonly rows="5" spellcheck="false"></textarea>
<div class="mt-3 flex justify-start">
<button id="copy" class="btn-outline" type="button"><svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-copy-icon lucide-copy"><rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>Copy</button>
</div>
</section>
<p id="error" class="hidden text-sm text-destructive"></p>
</section>
</section>
</main>
<script>
const $ = (id) => document.getElementById(id);
const b64u = {
  dec: (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0)),
  enc: (bytes) => btoa(String.fromCharCode(...bytes)).replace(/\\+/g, '-').replace(/\\//g, '_').replace(/=+$/g, '')
};
const checkIcon = '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-check-icon lucide-check"><path d="M20 6 9 17l-5-5"/></svg>';
function fail(message){
  $('error').textContent = message;
  $('error').className = 'mt-4 text-sm text-destructive';
}
async function encrypt(request, values) {
  const publicKey = await crypto.subtle.importKey('spki', Uint8Array.from(atob(request.publicKey), c => c.charCodeAt(0)), { name: 'RSA-OAEP', hash: 'SHA-256' }, false, ['encrypt']);
  const aes = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt']);
  const rawAes = new Uint8Array(await crypto.subtle.exportKey('raw', aes));
  const encryptedKey = new Uint8Array(await crypto.subtle.encrypt({ name: 'RSA-OAEP' }, publicKey, rawAes));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, aes, new TextEncoder().encode(JSON.stringify(values))));
  const out = new Uint8Array(2 + encryptedKey.length + iv.length + encrypted.length);
  new DataView(out.buffer).setUint16(0, encryptedKey.length);
  out.set(encryptedKey, 2);
  out.set(iv, 2 + encryptedKey.length);
  out.set(encrypted, 2 + encryptedKey.length + iv.length);
  return 'heypi-secret:' + request.id + ':' + b64u.enc(out);
}
try {
  const request = JSON.parse(new TextDecoder().decode(b64u.dec(location.hash.slice(1))));
  if (request.v !== 1 || !request.id || !request.publicKey || !Array.isArray(request.fields)) throw new Error('Invalid request');
  const form = $('form');
  for (const field of request.fields) {
    const row = document.createElement('section');
    row.className = 'grid gap-2';
    const label = document.createElement('label');
    label.className = 'text-sm font-medium';
    label.textContent = field.label || field.name;
    label.htmlFor = field.name;
    const textarea = document.createElement('textarea');
    textarea.className = 'textarea min-h-9 resize-none px-3 py-[7px]';
    textarea.id = field.name;
    textarea.name = field.name;
    textarea.rows = 1;
    textarea.autocomplete = 'off';
    textarea.spellcheck = false;
    textarea.required = true;
    row.append(label, textarea);
    form.append(row);
  }
  const button = document.createElement('button');
  button.className = 'btn btn-primary w-fit';
  button.type = 'submit';
  button.textContent = 'Encrypt';
  form.append(button);
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const values = {};
    for (const field of request.fields) values[field.name] = form.elements[field.name].value;
    $('blob').value = await encrypt(request, values);
    $('out').classList.remove('hidden');
  });
  $('copy').addEventListener('click', async () => {
    await navigator.clipboard.writeText($('blob').value);
    $('copy').innerHTML = checkIcon + 'Copied';
  });
} catch (error) {
  fail(error && error.message ? error.message : String(error));
}
</script>
</body>
</html>`;

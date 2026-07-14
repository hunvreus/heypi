import {
	constants,
	createCipheriv,
	createDecipheriv,
	generateKeyPairSync,
	type KeyObject,
	privateDecrypt,
	randomBytes,
} from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

const SECRET_REPLY_RE = /!secret:([^:\s]+):([A-Za-z0-9+/=]+)/;
const DEFAULT_PAGE_URL = "https://heypi.dev/secret";
const DEFAULT_TTL_MS = 30 * 60 * 1000;

export type SecretRequest = {
	id: string;
	name: string;
	description: string;
	url: string;
	expiresAt: string;
};

export type StoredSecret = {
	name: string;
	path: string;
	createdAt: string;
	updatedAt: string;
};

type PendingSecret = {
	id: string;
	name: string;
	description: string;
	dir: string;
	privateKeyPem: string;
	expiresAt: number;
};

export type SecretManager = {
	request(input: { name: string; description: string; dir: string }): Promise<SecretRequest>;
	accept(text: string): Promise<StoredSecret | undefined>;
	get(dir: string, name: string): Promise<string | undefined>;
	list(dir: string): Promise<StoredSecret[]>;
	pageHtml(): string;
};

type SecretManagerOptions = {
	keyPath: string;
	pageUrl?: string;
	submitUrl?: string;
	ttlMs?: number;
};

function b64url(input: Buffer | string): string {
	return Buffer.from(input).toString("base64url");
}

function safeSecretName(value: string): string {
	const name = basename(value.trim()).replaceAll(/[^a-zA-Z0-9_.-]/g, "-");
	if (!name || name === "." || name === "..")
		throw new Error("Secret name must contain letters, numbers, dots, dashes, or underscores.");
	return name;
}

async function readOrCreateKey(path: string): Promise<Buffer> {
	try {
		const raw = (await readFile(path, "utf8")).trim();
		const key = Buffer.from(raw, "base64");
		if (key.length === 32) return key;
	} catch {
		// Create below.
	}
	const key = randomBytes(32);
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, key.toString("base64"), { mode: 0o600 });
	return key;
}

function encryptAtRest(key: Buffer, plaintext: string): { iv: string; tag: string; ciphertext: string } {
	const iv = randomBytes(12);
	const cipher = createCipheriv("aes-256-gcm", key, iv);
	const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
	return {
		iv: iv.toString("base64"),
		tag: cipher.getAuthTag().toString("base64"),
		ciphertext: ciphertext.toString("base64"),
	};
}

function decryptAtRest(key: Buffer, record: { iv: string; tag: string; ciphertext: string }): string {
	const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(record.iv, "base64"));
	decipher.setAuthTag(Buffer.from(record.tag, "base64"));
	return Buffer.concat([decipher.update(Buffer.from(record.ciphertext, "base64")), decipher.final()]).toString("utf8");
}

function decryptReply(pending: PendingSecret, payload: string): string {
	const body = Buffer.from(payload, "base64");
	const keyLength = body.readUInt16BE(0);
	const encryptedKey = body.subarray(2, 2 + keyLength);
	const encryptedBody = body.subarray(2 + keyLength);
	const iv = encryptedBody.subarray(0, 12);
	const tag = encryptedBody.subarray(encryptedBody.length - 16);
	const ciphertext = encryptedBody.subarray(12, encryptedBody.length - 16);
	const key = privateDecrypt(
		{ key: pending.privateKeyPem, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" },
		encryptedKey,
	);
	const decipher = createDecipheriv("aes-256-gcm", key, iv);
	decipher.setAuthTag(tag);
	return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}

function requestUrl(input: {
	pageUrl: string;
	id: string;
	name: string;
	description: string;
	publicKey: Buffer | string | KeyObject;
	submitUrl?: string;
}): string {
	const payload = {
		v: 1,
		r: input.id,
		n: input.name,
		d: input.description,
		k: Buffer.isBuffer(input.publicKey)
			? input.publicKey.toString("base64")
			: Buffer.from(String(input.publicKey)).toString("base64"),
		post: input.submitUrl,
	};
	return `${input.pageUrl}#${b64url(JSON.stringify(payload))}`;
}

async function writeSecret(
	key: Buffer,
	dir: string,
	name: string,
	plaintext: string,
	now = new Date().toISOString(),
): Promise<StoredSecret> {
	await mkdir(dir, { recursive: true });
	const file = join(dir, `${safeSecretName(name)}.json`);
	const record = { name, createdAt: now, updatedAt: now, ...encryptAtRest(key, plaintext) };
	await writeFile(file, `${JSON.stringify(record, null, "\t")}\n`, { mode: 0o600 });
	return { name, path: file, createdAt: record.createdAt, updatedAt: record.updatedAt };
}

export function createSecretManager(options: SecretManagerOptions): SecretManager {
	const pending = new Map<string, PendingSecret>();
	const pageUrl = options.pageUrl ?? DEFAULT_PAGE_URL;
	const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
	let key: Promise<Buffer> | undefined;
	const storageKey = () => (key ??= readOrCreateKey(options.keyPath));

	return {
		async request(input) {
			const name = safeSecretName(input.name);
			const { publicKey, privateKey } = generateKeyPairSync("rsa", {
				modulusLength: 2048,
				publicKeyEncoding: { type: "spki", format: "der" },
				privateKeyEncoding: { type: "pkcs8", format: "pem" },
			});
			const id = `${Date.now()}-${randomBytes(4).toString("hex")}`;
			const expiresAt = Date.now() + ttlMs;
			pending.set(id, {
				id,
				name,
				description: input.description,
				dir: input.dir,
				privateKeyPem: String(privateKey),
				expiresAt,
			});
			return {
				id,
				name,
				description: input.description,
				url: requestUrl({
					pageUrl,
					id,
					name,
					description: input.description,
					publicKey: publicKey as Buffer,
					submitUrl: options.submitUrl,
				}),
				expiresAt: new Date(expiresAt).toISOString(),
			};
		},
		async accept(text) {
			const match = text.match(SECRET_REPLY_RE);
			if (!match) return undefined;
			const [, id, payload] = match;
			const item = pending.get(id);
			if (!item || item.expiresAt < Date.now()) {
				pending.delete(id);
				return undefined;
			}
			const plaintext = decryptReply(item, payload);
			pending.delete(id);
			return writeSecret(await storageKey(), item.dir, item.name, plaintext);
		},
		async get(dir, name) {
			const file = join(dir, `${safeSecretName(name)}.json`);
			try {
				const record = JSON.parse(await readFile(file, "utf8")) as { iv: string; tag: string; ciphertext: string };
				return decryptAtRest(await storageKey(), record);
			} catch {
				return undefined;
			}
		},
		async list(dir) {
			try {
				const files = await readdir(dir);
				const records = await Promise.all(
					files
						.filter((file) => file.endsWith(".json"))
						.map(async (file) => {
							const record = JSON.parse(await readFile(join(dir, file), "utf8")) as {
								name?: string;
								createdAt?: string;
								updatedAt?: string;
							};
							return {
								name: record.name ?? file.slice(0, -5),
								path: join(dir, file),
								createdAt: record.createdAt ?? "",
								updatedAt: record.updatedAt ?? "",
							};
						}),
				);
				return records;
			} catch {
				return [];
			}
		},
		pageHtml: secretPageHtml,
	};
}

export function secretPageHtml(): string {
	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>heypi secret</title>
<style>
body{font-family:system-ui,sans-serif;margin:32px;line-height:1.45;color:#111;background:#fafafa}
main{max-width:720px}
label{display:block;font-weight:600;margin-top:16px}
textarea,input{box-sizing:border-box;width:100%;font:inherit;margin-top:6px;padding:10px;border:1px solid #ccc;border-radius:6px;background:white}
textarea{min-height:120px}
button{margin-top:16px;padding:10px 14px;font:inherit;border:0;border-radius:6px;background:#111;color:white}
code{background:#eee;padding:2px 4px}
.muted{color:#555}
.error{color:#b00020}
.ok{color:#0b6b2b}
</style>
</head>
<body>
<main>
<h1>Send a secret to heypi</h1>
<p id="meta" class="muted">Loading request...</p>
<label for="secret">Secret value</label>
<textarea id="secret" autocomplete="off" spellcheck="false"></textarea>
<button id="encrypt">Encrypt</button>
<p id="status" class="muted"></p>
<label for="reply">Encrypted reply</label>
<textarea id="reply" readonly></textarea>
</main>
<script>
function b64ToBytes(value){const bin=atob(value);const out=new Uint8Array(bin.length);for(let i=0;i<bin.length;i++)out[i]=bin.charCodeAt(i);return out}
function bytesToB64(value){let bin="";for(const byte of value)bin+=String.fromCharCode(byte);return btoa(bin)}
function readPayload(){const raw=location.hash.slice(1);if(!raw)throw new Error("Missing request payload.");return JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(raw.replaceAll("-","+").replaceAll("_","/")),c=>c.charCodeAt(0))))}
async function encrypt(payload, secret){
	const publicKey=await crypto.subtle.importKey("spki", b64ToBytes(payload.k), {name:"RSA-OAEP", hash:"SHA-256"}, false, ["encrypt"]);
	const aes=await crypto.subtle.generateKey({name:"AES-GCM", length:256}, true, ["encrypt"]);
	const rawAes=new Uint8Array(await crypto.subtle.exportKey("raw", aes));
	const encryptedKey=new Uint8Array(await crypto.subtle.encrypt({name:"RSA-OAEP"}, publicKey, rawAes));
	const iv=crypto.getRandomValues(new Uint8Array(12));
	const encrypted=new Uint8Array(await crypto.subtle.encrypt({name:"AES-GCM", iv}, aes, new TextEncoder().encode(secret)));
	const body=new Uint8Array(2+encryptedKey.length+iv.length+encrypted.length);
	body[0]=(encryptedKey.length>>8)&255;body[1]=encryptedKey.length&255;
	body.set(encryptedKey,2);body.set(iv,2+encryptedKey.length);body.set(encrypted,2+encryptedKey.length+iv.length);
	return "!secret:"+payload.r+":"+bytesToB64(body);
}
let payload;
try{
	payload=readPayload();
	document.getElementById("meta").textContent=(payload.n||"Secret")+": "+(payload.d||"Paste the requested secret.");
}catch(error){
	document.getElementById("meta").textContent=error.message;
	document.getElementById("meta").className="error";
}
document.getElementById("encrypt").addEventListener("click", async()=>{
	const status=document.getElementById("status");
	try{
		const reply=await encrypt(payload, document.getElementById("secret").value);
		document.getElementById("reply").value=reply;
		if(payload.post){
			const response=await fetch(payload.post,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({reply})});
			if(response.ok){status.textContent="Secret submitted.";status.className="ok";return}
		}
		status.textContent="Copy the encrypted reply and paste it back into chat.";
		status.className="muted";
	}catch(error){
		status.textContent=error.message;
		status.className="error";
	}
});
</script>
</body>
</html>`;
}

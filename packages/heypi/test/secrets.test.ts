import { constants, createCipheriv, publicEncrypt, randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createSecretManager, secretPageHtml } from "../src/secrets.js";

function state(name: string): string {
	return join(tmpdir(), `heypi-secret-${name}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
}

function decodeRequest(url: string): { r: string; k: string } {
	const hash = new URL(url).hash.slice(1);
	const json = Buffer.from(hash, "base64url").toString("utf8");
	return JSON.parse(json) as { r: string; k: string };
}

function encryptedReply(url: string, secret: string): string {
	const request = decodeRequest(url);
	const key = randomBytes(32);
	const iv = randomBytes(12);
	const cipher = createCipheriv("aes-256-gcm", key, iv);
	const ciphertext = Buffer.concat([cipher.update(secret, "utf8"), cipher.final(), cipher.getAuthTag()]);
	const encryptedKey = publicEncrypt(
		{
			key: Buffer.from(request.k, "base64"),
			format: "der",
			type: "spki",
			padding: constants.RSA_PKCS1_OAEP_PADDING,
			oaepHash: "sha256",
		},
		key,
	);
	const body = Buffer.alloc(2 + encryptedKey.length + iv.length + ciphertext.length);
	body.writeUInt16BE(encryptedKey.length, 0);
	encryptedKey.copy(body, 2);
	iv.copy(body, 2 + encryptedKey.length);
	ciphertext.copy(body, 2 + encryptedKey.length + iv.length);
	return `!secret:${request.r}:${body.toString("base64")}`;
}

describe("secrets", () => {
	it("accepts encrypted replies and stores encrypted-at-rest", async () => {
		const root = state("roundtrip");
		const manager = createSecretManager({ keyPath: join(root, "secrets.key"), pageUrl: "https://heypi.dev/secret" });
		const dir = join(root, "adapters", "a", "conversations", "c", "secrets");
		const request = await manager.request({ name: "github-token", description: "GitHub token", dir });

		const stored = await manager.accept(encryptedReply(request.url, "ghp_test"));

		expect(stored).toMatchObject({ name: "github-token" });
		await expect(manager.get(dir, "github-token")).resolves.toBe("ghp_test");
		await expect(readFile(join(dir, "github-token.json"), "utf8")).resolves.not.toContain("ghp_test");
	});

	it("does not accept a secret reply twice", async () => {
		const root = state("single-use");
		const manager = createSecretManager({ keyPath: join(root, "secrets.key") });
		const dir = join(root, "secrets");
		const request = await manager.request({ name: "token", description: "Token", dir });
		const reply = encryptedReply(request.url, "secret");

		expect(await manager.accept(reply)).toMatchObject({ name: "token" });
		await expect(manager.accept(reply)).resolves.toBeUndefined();
	});

	it("serves a static browser encryption page", () => {
		expect(secretPageHtml()).toContain("Send a secret to heypi");
		expect(secretPageHtml()).toContain("crypto.subtle");
		expect(secretPageHtml()).toContain("!secret:");
	});
});

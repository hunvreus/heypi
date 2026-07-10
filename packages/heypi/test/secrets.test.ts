import { constants, createCipheriv, createPublicKey, publicEncrypt, randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createSecretExchange } from "../src/secrets.js";

function encryptedReply(widgetUrl: string, value: string): string {
	const payload = JSON.parse(Buffer.from(widgetUrl.split("#")[1] ?? "", "base64").toString("utf8")) as {
		k: string;
		r: string;
	};
	const key = randomBytes(32);
	const iv = randomBytes(12);
	const cipher = createCipheriv("aes-256-gcm", key, iv);
	const ciphertext = Buffer.concat([cipher.update(value), cipher.final()]);
	const tag = cipher.getAuthTag();
	const publicKey = createPublicKey({ key: Buffer.from(payload.k, "base64"), type: "spki", format: "der" });
	const encryptedKey = publicEncrypt(
		{ key: publicKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" },
		key,
	);
	const length = Buffer.alloc(2);
	length.writeUInt16BE(encryptedKey.length, 0);
	const encrypted = Buffer.concat([length, encryptedKey, iv, ciphertext, tag]).toString("base64");
	return `!secret:${payload.r}:${encrypted}`;
}

describe("secret exchange", () => {
	it("decrypts encrypted replies for pending requests", () => {
		const exchange = createSecretExchange();
		const request = exchange.create("github-token", "GitHub token");
		const reply = encryptedReply(request.widgetUrl, "ghp_secret");

		expect(exchange.decrypt(reply)).toEqual({
			id: request.id,
			name: "github-token",
			value: "ghp_secret",
		});
		expect(exchange.decrypt(reply)).toBeUndefined();
	});

	it("ignores unrelated secret replies", () => {
		const exchange = createSecretExchange();

		expect(exchange.decrypt("hello")).toBeUndefined();
		expect(exchange.decrypt("!secret:missing:aaaa")).toBeUndefined();
	});
});

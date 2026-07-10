import { constants, createDecipheriv, generateKeyPairSync, privateDecrypt, randomUUID } from "node:crypto";

export type SecretRequest = {
	id: string;
	name: string;
	description: string;
	widgetUrl: string;
};

export type DecryptedSecret = {
	id: string;
	name: string;
	value: string;
};

type PendingSecret = {
	name: string;
	privateKey: string;
};

/**
 * Creates encrypted secret requests and decrypts matching user replies.
 *
 * This module only owns the cryptographic exchange. It does not store secrets,
 * expose them to runtimes, or decide how adapters collect replies.
 */
export function createSecretExchange() {
	const pending = new Map<string, PendingSecret>();

	return {
		create(name: string, description: string): SecretRequest {
			const id = randomUUID();
			const { publicKey, privateKey } = generateKeyPairSync("rsa", {
				modulusLength: 2048,
				publicKeyEncoding: { type: "spki", format: "der" },
				privateKeyEncoding: { type: "pkcs8", format: "pem" },
			});
			pending.set(id, { name, privateKey: privateKey as string });
			const hash = Buffer.from(
				JSON.stringify({
					n: name,
					d: description,
					k: (publicKey as Buffer).toString("base64"),
					r: id,
				}),
			).toString("base64");
			return { id, name, description, widgetUrl: `https://pi.dev/secret#${hash}` };
		},

		decrypt(text: string): DecryptedSecret | undefined {
			const match = text.match(/!secret:([^:]+):([A-Za-z0-9+/=]+)/);
			if (!match) return undefined;
			const [, id, payload] = match;
			const request = pending.get(id);
			if (!request) return undefined;
			try {
				const data = Buffer.from(payload, "base64");
				const keyLength = data.readUInt16BE(0);
				const encryptedKey = data.subarray(2, 2 + keyLength);
				const encryptedValue = data.subarray(2 + keyLength);
				const iv = encryptedValue.subarray(0, 12);
				const tag = encryptedValue.subarray(encryptedValue.length - 16);
				const ciphertext = encryptedValue.subarray(12, encryptedValue.length - 16);
				const key = privateDecrypt(
					{ key: request.privateKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" },
					encryptedKey,
				);
				const decipher = createDecipheriv("aes-256-gcm", key, iv);
				decipher.setAuthTag(tag);
				const value = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
				pending.delete(id);
				return { id, name: request.name, value };
			} catch {
				return undefined;
			}
		},
	};
}

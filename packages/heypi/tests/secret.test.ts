import assert from "node:assert/strict";
import { constants, createCipheriv, createPublicKey, publicEncrypt, randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { CallRunner } from "../src/core/calls.js";
import { resolveScope } from "../src/core/scope.js";
import { normalizeSecretsConfig, Secrets, secretCss, secretPage, secretStyleRoute } from "../src/core/secrets.js";
import { createHandler } from "../src/io/handler.js";
import { Queue } from "../src/runtime/queue.js";
import type { Runtime } from "../src/runtime/types.js";
import { sqliteStore } from "../src/store/sqlite.js";

async function tempDb(): Promise<{ path: string; cleanup: () => Promise<void> }> {
	const dir = await mkdtemp(join(tmpdir(), "heypi-secret-"));
	return { path: join(dir, "store.db"), cleanup: () => rm(dir, { recursive: true, force: true }) };
}

function secretBlob(url: string, values: Record<string, string>): string {
	const fragment = new URL(url).hash.slice(1);
	const request = JSON.parse(Buffer.from(fragment, "base64url").toString("utf8")) as {
		id: string;
		publicKey: string;
	};
	const aes = randomBytes(32);
	const iv = randomBytes(12);
	const encryptedKey = publicEncrypt(
		{
			key: createPublicKey({ key: Buffer.from(request.publicKey, "base64"), format: "der", type: "spki" }),
			padding: constants.RSA_PKCS1_OAEP_PADDING,
			oaepHash: "sha256",
		},
		aes,
	);
	const cipher = createCipheriv("aes-256-gcm", aes, iv);
	const ciphertext = Buffer.concat([cipher.update(JSON.stringify(values), "utf8"), cipher.final()]);
	const tag = cipher.getAuthTag();
	const header = Buffer.alloc(2);
	header.writeUInt16BE(encryptedKey.length, 0);
	const payload = Buffer.concat([header, encryptedKey, iv, ciphertext, tag]).toString("base64url");
	return `heypi-secret:${request.id}:${payload}`;
}

test("secret config uses one public URL and optional self-host serving", () => {
	assert.deepEqual(normalizeSecretsConfig(true), {
		enabled: true,
		url: "https://heypi.dev/secret",
		serve: false,
		expiresInMs: 600_000,
		maxFields: 8,
	});
	assert.deepEqual(normalizeSecretsConfig({ url: "https://example.com/heypi/secret", serve: true }), {
		enabled: true,
		url: "https://example.com/heypi/secret",
		serve: true,
		expiresInMs: 600_000,
		maxFields: 8,
	});
	assert.equal(secretStyleRoute("https://example.com/heypi/secret"), "/heypi/secret.css");
});

test("secret requests decrypt only for the matching scope", () => {
	const config = normalizeSecretsConfig({ enabled: true, url: "https://example.com/secret" });
	const store = new Secrets(config);
	const keys = resolveScope({
		agent: "agent",
		provider: "slack",
		kind: "slack",
		team: "T1",
		channel: "C1",
		actor: "U1",
	});
	const request = store.create(keys.channel, {
		reason: "Need an API token.",
		fields: [{ name: "API_TOKEN", label: "API token" }],
		actor: "U1",
	});
	const blob = secretBlob(request.url, { API_TOKEN: "secret-value" });

	const wrongScope = store.create(keys.channel, {
		reason: "Need another API token.",
		fields: [{ name: "OTHER_TOKEN" }],
		actor: "U1",
	});
	assert.equal(
		store.complete(secretBlob(wrongScope.url, { OTHER_TOKEN: "secret-value" }), keys.user, "U1"),
		undefined,
	);

	assert.equal(store.complete(blob, keys.channel, "U2"), undefined);
	const completed = store.complete(blob, keys.channel, "U1");
	assert.deepEqual(completed?.files, [{ name: "API_TOKEN", path: ".secrets/API_TOKEN", value: "secret-value" }]);
	assert.match(secretPage(), /heypi-secret/);
	assert.match(secretPage(), /rel="stylesheet"/);
	assert.match(secretPage(), /class="textarea/);
	assert.match(secretCss(), /\.btn/);
});

test("secrets save completed values through an explicit write target", async () => {
	const config = normalizeSecretsConfig({ enabled: true, url: "https://example.com/secret" });
	const store = new Secrets(config);
	const keys = resolveScope({
		agent: "agent",
		provider: "slack",
		kind: "slack",
		team: "T1",
		channel: "C1",
		actor: "U1",
	});
	const request = store.create(keys.channel, {
		reason: "Need an API token.",
		fields: [{ name: "API_TOKEN" }],
		actor: "U1",
	});
	const completed = store.complete(secretBlob(request.url, { API_TOKEN: "secret-value" }), keys.channel, "U1");
	assert.ok(completed);
	const writes: Array<{ path: string; content: string }> = [];

	const paths = await store.save(completed, {
		write: async (input) => {
			writes.push({ path: input.path, content: input.content });
			return { path: input.path, bytes: input.content.length };
		},
	});

	assert.deepEqual(paths, [".secrets/API_TOKEN"]);
	assert.deepEqual(writes, [{ path: ".secrets/API_TOKEN", content: "secret-value" }]);
});

test("handler stores secret replies in the selected runtime without model exposure", async () => {
	const db = await tempDb();
	try {
		const store = sqliteStore({ path: db.path });
		await store.setup();
		const secrets = new Secrets(normalizeSecretsConfig(true));
		const keys = resolveScope({
			agent: "a",
			provider: "slack",
			kind: "slack",
			team: "T1",
			channel: "C1",
			actor: "U1",
		});
		const request = secrets.create(keys.channel, {
			reason: "Need a deploy token.",
			fields: [{ name: "DEPLOY_TOKEN" }],
			actor: "U1",
		});
		const writes: Array<{ path: string; content: string }> = [];
		const runtime: Runtime = {
			name: "test-runtime",
			root: ".",
			write: async (input) => {
				writes.push({ path: input.path, content: input.content });
				return { path: input.path, bytes: input.content.length };
			},
		};
		const handler = createHandler({
			agentId: "a",
			store,
			callRunner: new CallRunner(store.calls, store.approvals, new Queue({}), runtime),
			runtime: () => runtime,
			secrets,
			agent: {
				ask: async () => {
					throw new Error("model should not see secret replies");
				},
				continue: async () => ({ text: "unused" }),
			},
		});

		const wrongActor = await handler({
			trace: "trace-secret-wrong-actor",
			provider: "slack",
			team: "T1",
			channel: "C1",
			actor: "U2",
			thread: "C1",
			text: secretBlob(request.url, { DEPLOY_TOKEN: "poisoned" }),
		});

		assert.equal(wrongActor?.private, true);
		assert.match(wrongActor?.text ?? "", /expired, invalid, or for another scope/);
		assert.deepEqual(writes, []);

		const out = await handler({
			trace: "trace-secret",
			provider: "slack",
			team: "T1",
			channel: "C1",
			actor: "U1",
			thread: "C1",
			text: secretBlob(request.url, { DEPLOY_TOKEN: "deploy-secret" }),
		});

		assert.equal(out?.private, true);
		assert.match(out?.text ?? "", /\.secrets\/DEPLOY_TOKEN/);
		assert.deepEqual(writes, [{ path: ".secrets/DEPLOY_TOKEN", content: "deploy-secret" }]);
	} finally {
		await db.cleanup();
	}
});

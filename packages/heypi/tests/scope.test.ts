import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { MemoryStore, memoryContext, normalizeMemoryConfig } from "../src/core/memory.js";
import { resolveScope, ScopedRuntimeRegistry, selectScope } from "../src/core/scope.js";
import type { RuntimeProvider, RuntimeScope } from "../src/runtime/types.js";

async function temp(): Promise<string> {
	return await mkdtemp(join(tmpdir(), "heypi-scope-"));
}

test("scope keys are stable and path-safe", () => {
	const keys = resolveScope({
		agent: "agent",
		provider: "slack",
		kind: "slack",
		team: "T/1",
		channel: "C:prod/incidents",
		actor: "U/1",
	});

	assert.equal(keys.agent.path, "agent/agent");
	assert.equal(keys.adapter.path, "adapter/agent/slack");
	assert.equal(keys.channel.path, "channel/agent/slack/T~2F1/C~3Aprod~2Fincidents");
	assert.equal(keys.user.path, "user/agent/slack/T~2F1/U~2F1");
	assert.equal(selectScope(keys, undefined), keys.channel);
	assert.equal(selectScope(keys, "agent"), keys.agent);
	assert.equal(selectScope(keys, "user"), keys.user);
});

test("scope keys encode arbitrary provider ids without path traversal", () => {
	const keys = resolveScope({
		agent: "../agent",
		provider: "webhook",
		kind: "webhook",
		team: "../../tenant\nx",
		channel: "../prod/%2F/../../secret",
		actor: "../actor/%2F/../../secret",
	});

	assert.equal(keys.agent.path, "agent/..~2Fagent");
	assert.equal(
		keys.channel.path,
		"channel/..~2Fagent/webhook/..~2F..~2Ftenant~0Ax/..~2Fprod~2F~252F~2F..~2F..~2Fsecret",
	);
	assert.doesNotMatch(keys.channel.path, /(^|\/)\.\.(\/|$)/);
	assert.doesNotMatch(keys.user.path, /(^|\/)\.\.(\/|$)/);
});

test("scoped runtime registry creates one runtime root per selected scope", async () => {
	const root = await temp();
	try {
		const keys = resolveScope({
			agent: "agent",
			provider: "discord",
			kind: "discord",
			channel: "general",
			actor: "user",
		});
		const registry = new ScopedRuntimeRegistry({ name: "just-bash", root }, { app: process.cwd() });
		const channel = registry.get(keys.channel);
		const adapter = registry.get(keys.adapter);

		assert.notEqual(channel.root, adapter.root);
		assert.match(channel.root, /scopes\/channel\/agent\/discord\/none\/general$/);
		assert.equal(registry.get(keys.channel), channel);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("scoped runtime registry delegates scoped roots to runtime providers", async () => {
	const root = await temp();
	try {
		const scopes: RuntimeScope[] = [];
		let closed = false;
		const provider: RuntimeProvider = {
			get: (scope) => {
				scopes.push(scope);
				return { name: "test-runtime", root: scope.root };
			},
			close: () => {
				closed = true;
			},
		};
		const keys = resolveScope({
			agent: "agent",
			provider: "slack",
			kind: "slack",
			team: "T1",
			channel: "C1",
			actor: "U1",
		});
		const registry = new ScopedRuntimeRegistry({ root, provider }, { app: process.cwd() });
		const runtime = registry.get(keys.user);

		assert.equal(runtime.name, "test-runtime");
		assert.match(runtime.root, /scopes\/user\/agent\/slack\/T1\/U1$/);
		assert.deepEqual(scopes, [
			{
				level: "user",
				key: "user/agent/slack/T1/U1",
				path: "user/agent/slack/T1/U1",
				root: runtime.root,
			},
		]);

		await registry.close();
		assert.equal(closed, true);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("memory store is opt-in, scoped, bounded, and sanitized", async () => {
	const root = await temp();
	try {
		const keys = resolveScope({
			agent: "agent",
			provider: "telegram",
			kind: "telegram",
			channel: "-100123",
			actor: "42",
		});
		const disabled = new MemoryStore(root, normalizeMemoryConfig(undefined));
		assert.equal(await disabled.read(keys.channel), "");

		const memory = new MemoryStore(root, normalizeMemoryConfig({ enabled: true, maxChars: 80 }));
		await memory.append(keys.channel, "This chat tracks production incidents.");
		await memory.append(keys.agent, "Global fact.");

		assert.match(await memory.read(keys.channel), /production incidents/);
		assert.doesNotMatch(await memory.read(keys.channel), /Global fact/);
		assert.match(memoryContext(keys.channel, "<remember me>") ?? "", /&lt;remember me&gt;/);
		await assert.rejects(() => memory.append(keys.channel, "API_KEY=secret"), /secret/);
		await assert.rejects(() => memory.append(keys.channel, "x".repeat(90)), /limit|too long/);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("memory config defaults write policy by scope", () => {
	assert.deepEqual(normalizeMemoryConfig(true), {
		enabled: true,
		scope: "channel",
		writePolicy: "auto",
		maxChars: 4000,
	});
	assert.deepEqual(normalizeMemoryConfig(true, { approvers: ["U1"] }), {
		enabled: true,
		scope: "channel",
		writePolicy: "approvers",
		maxChars: 4000,
	});
	assert.deepEqual(normalizeMemoryConfig({ enabled: true, scope: "user" }), {
		enabled: true,
		scope: "user",
		writePolicy: "auto",
		maxChars: 4000,
	});
	assert.deepEqual(normalizeMemoryConfig({ enabled: true, scope: "agent" }), {
		enabled: true,
		scope: "agent",
		writePolicy: "off",
		maxChars: 4000,
	});
	assert.equal(
		normalizeMemoryConfig({ enabled: true, scope: "agent" }, { approvers: ["U1"] }).writePolicy,
		"approvers",
	);
	assert.equal(normalizeMemoryConfig({ enabled: true, scope: "agent", writePolicy: "auto" }).writePolicy, "auto");
});

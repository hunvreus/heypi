import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import { createHostTools, HostStore } from "../examples/slack-devops/host-tools.js";

async function tempRoot(): Promise<{ path: string; cleanup: () => Promise<void> }> {
	const path = await mkdtemp(join(tmpdir(), "heypi-host-tools-"));
	return { path, cleanup: () => rm(path, { recursive: true, force: true }) };
}

test("HostStore upserts hosts with a generated public key but no private key in inventory", async () => {
	const root = await tempRoot();
	try {
		const store = new HostStore(root.path);
		const host = await store.upsert({
			id: "api-1",
			address: "203.0.113.10",
			user: "deploy",
			tags: ["api", "prod"],
		});

		assert.equal(host.id, "api-1");
		assert.equal(host.key, "default");
		assert.match(host.publicKey ?? "", /^ssh-ed25519 /);
		assert.equal(existsSync(join(root.path, "keys", "default")), true);

		const raw = await readFile(join(root.path, "hosts.json"), "utf8");
		assert.match(raw, /ssh-ed25519/);
		assert.doesNotMatch(raw, /PRIVATE KEY/);
		assert.deepEqual(
			(await store.resolve("prod")).map((item) => item.id),
			["api-1"],
		);
	} finally {
		await root.cleanup();
	}
});

test("host_exec blocks blocked commands before attempting SSH", async () => {
	const root = await tempRoot();
	try {
		const store = new HostStore(root.path);
		await store.upsert({ id: "api-1", address: "203.0.113.10", user: "deploy" });
		const hostExec = requiredTool(createHostTools({ root: root.path }), "host_exec");
		const out = await hostExec.execute(
			"call-1",
			{ hosts: ["api-1"], command: "rm -rf /" },
			undefined,
			undefined,
			undefined as never,
		);
		assert.equal(text(out), "blocked: blocked by /\\brm\\s+-rf\\s+\\/(?:\\s|$)/i");
	} finally {
		await root.cleanup();
	}
});

test("hosts_upsert returns the public key installation instruction", async () => {
	const root = await tempRoot();
	try {
		const upsert = requiredTool(createHostTools({ root: root.path }), "hosts_upsert");
		const out = await upsert.execute(
			"call-1",
			{ id: "web-1", address: "203.0.113.10", user: "deploy" },
			undefined,
			undefined,
			undefined as never,
		);
		const body = text(out);
		assert.match(body, /Saved host web-1/);
		assert.match(body, /~\/\.ssh\/authorized_keys for user deploy on 203\.0\.113\.10/);
		assert.match(body, /tell me the key is installed/);
		assert.match(body, /ssh-ed25519 /);
		assert.doesNotMatch(body, /PRIVATE KEY/);
	} finally {
		await root.cleanup();
	}
});

function requiredTool(tools: ToolDefinition[], name: string): ToolDefinition {
	const match = tools.find((tool) => tool.name === name);
	if (!match) throw new Error(`missing tool: ${name}`);
	return match;
}

function text(result: Awaited<ReturnType<ToolDefinition["execute"]>>): string {
	return result.content
		.filter((part): part is { type: "text"; text: string } => part.type === "text")
		.map((part) => part.text)
		.join("\n");
}

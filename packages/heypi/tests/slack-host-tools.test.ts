import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { defaultTools, loadAgent } from "../src/api.js";
import { createHostContext, createHostTools, HostStore } from "../../../examples/slack-devops/agent/tools/host.js";

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

test("host context summarizes configured hosts for the prompt", async () => {
	const root = await tempRoot();
	try {
		const store = new HostStore(root.path);
		await store.upsert({
			id: "db-1",
			address: "203.0.113.20",
			user: "deploy",
			tags: ["db", "prod"],
			aliases: ["primary-db"],
		});
		const context = createHostContext({ root: root.path });
		const out = await context({ provider: "slack", channel: "slack:T1:C1", actor: "U1", threadId: "thread-1" });
		assert.deepEqual(out, {
			title: "Known hosts",
			text: "- db-1 deploy@203.0.113.20:22 tags=db,prod aliases=primary-db",
		});
	} finally {
		await root.cleanup();
	}
});

test("host context includes cached facts", async () => {
	const root = await tempRoot();
	try {
		const store = new HostStore(root.path);
		const host = await store.upsert({
			id: "db-1",
			address: "203.0.113.20",
			user: "deploy",
			tags: ["db", "prod"],
		});
		await store.setFacts(host.id, {
			hostname: "db-1",
			os: "Linux",
			arch: "x86_64",
			kernel: "6.8.0",
			distro: "ubuntu",
			pkgManager: "apt",
			serviceManager: "systemd",
			containerRuntime: "docker",
			hasSudo: true,
		});

		const context = createHostContext({ root: root.path });
		const out = await context({ provider: "slack", channel: "slack:T1:C1", actor: "U1", threadId: "thread-1" });

		assert.equal(
			typeof out === "object" && out ? out.text : "",
			"- db-1 deploy@203.0.113.20:22 tags=db,prod facts=hostname=db-1, os=Linux, arch=x86_64, kernel=6.8.0, distro=ubuntu, pkg=apt, service=systemd, container=docker, sudo=yes",
		);
	} finally {
		await root.cleanup();
	}
});

test("Slack example tools are discovered from agent/tools", () => {
	const agent = loadAgent(resolve("../..", "examples/slack-devops/agent"), {
		model: "openai/gpt-5-mini",
		tools: defaultTools(),
	});
	const names = (agent.tools ?? []).map((tool) => ("name" in tool ? tool.name : ""));
	assert.ok(names.includes("host_exec"));
	assert.ok(names.includes("hosts_list"));
	assert.ok(names.includes("runbook_search"));
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

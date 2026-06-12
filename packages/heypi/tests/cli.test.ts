import assert from "node:assert/strict";
import { execFile, execFileSync, spawn, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { sqliteStore } from "@hunvreus/heypi";
import { verifyAdminLoginToken } from "../src/admin/auth.js";

const CLI = resolve("dist/cli.js");
const CONVERT_DOCUMENT = resolve("bin/heypi-convert-document");
const PACKAGE_VERSION = packageVersion();

function packageVersion(): string {
	const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version?: unknown };
	if (typeof pkg.version !== "string") throw new Error("package.json version must be a string");
	return pkg.version;
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function cli(args: string[], input?: { env?: NodeJS.ProcessEnv; cwd?: string }): string {
	return execFileSync(process.execPath, [CLI, ...args], {
		cwd: input?.cwd ?? process.cwd(),
		env: { ...process.env, ...(input?.env ?? {}) },
		encoding: "utf8",
	});
}

function cliAsync(args: string[], input?: { env?: NodeJS.ProcessEnv; cwd?: string }): Promise<string> {
	return new Promise((resolve, reject) => {
		execFile(
			process.execPath,
			[CLI, ...args],
			{
				cwd: input?.cwd ?? process.cwd(),
				env: { ...process.env, ...(input?.env ?? {}) },
				encoding: "utf8",
			},
			(error, stdout, stderr) => {
				if (error) {
					error.message = `${error.message}\n${stderr}`;
					reject(error);
					return;
				}
				resolve(stdout);
			},
		);
	});
}

test("cli prints help and version", () => {
	const help = cli(["help"]);
	assert.match(help, new RegExp(`heypi ${escapeRegExp(PACKAGE_VERSION)}`));
	assert.match(help, /heypi init/);
	assert.match(help, /heypi slack channels/);
	assert.equal(cli(["version"]).trim(), PACKAGE_VERSION);
	assert.match(cli(["init"]), /npm create heypi@latest/);
});

test("cli check loads env file and validates runtime root", async () => {
	const root = await mkdtemp(join(tmpdir(), "heypi-cli-check-"));
	try {
		const env = join(root, ".env");
		await writeFile(env, "OPENAI_API_KEY=openai-api-key\n", "utf8");
		const out = cli(["check", "--env", env, "--runtime-root", root]);
		assert.match(out, /ok: node /);
		assert.match(out, /ok: OPENAI_API_KEY present/);
		assert.match(out, /ok: runtime root exists/);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("cli check loads .env by default", async () => {
	const root = await mkdtemp(join(tmpdir(), "heypi-cli-default-env-"));
	try {
		await writeFile(join(root, ".env"), "OPENAI_API_KEY=openai-api-key\n", "utf8");
		const out = cli(["check", "--runtime-root", root], { cwd: root });
		assert.match(out, /ok: OPENAI_API_KEY present/);
		assert.match(out, /ok: runtime root exists/);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("cli status summarizes persisted operator state", async () => {
	const root = await mkdtemp(join(tmpdir(), "heypi-cli-status-"));
	try {
		const path = join(root, "heypi.db");
		assert.match(cli(["db", "migrate", "--db", path]), /ok: database migrated/);
		const store = sqliteStore({ path });
		await store.setup();
		const thread = await store.threads.getOrCreate({
			agent: "test",
			provider: "slack",
			kind: "slack",
			channel: "slack:T1:C1",
			key: "C1",
		});
		const message = await store.messages.create({
			threadId: thread.id,
			provider: "slack",
			kind: "slack",
			role: "user",
			actor: "U1",
			text: "deploy",
		});
		await store.turns.create({
			threadId: thread.id,
			inputMessageId: message.id,
			agent: "test",
			provider: "slack",
			kind: "slack",
			channel: thread.channel,
			actor: "U1",
		});
		const call = await store.calls.create({
			agent: "test",
			threadId: thread.id,
			messageId: message.id,
			channel: thread.channel,
			actor: "U1",
			tool: "bash",
			command: "deploy",
			state: "pending_approval",
		});
		const approval = await store.approvals.create({
			agent: "test",
			callId: call.id,
			channel: thread.channel,
			command: "deploy",
			runtime: "host-bash",
			reason: "Deploy",
		});
		await store.approvalBypasses?.create({
			agent: "test",
			scope: "thread",
			channel: thread.channel,
			threadId: thread.id,
			actor: "U1",
			createdBy: "U_ADMIN",
			approvalId: approval.id,
			expiresAt: Date.now() + 60_000,
		});
		await store.jobs?.upsert({
			id: "daily",
			agent: "test",
			kind: "heartbeat",
			schedule: JSON.stringify({ everyMs: 60_000 }),
			prompt: "check",
			state: "active",
			nextAt: Date.now() - 1000,
		});
		await store.locks?.acquire({ key: "app:test", owner: "status-test", ttlMs: 60_000 });
		for (let i = 0; i < 101; i++) {
			const extraCall = await store.calls.create({
				agent: "test",
				threadId: thread.id,
				messageId: message.id,
				channel: thread.channel,
				actor: "U1",
				tool: "bash",
				command: `deploy-${i}`,
				state: "pending_approval",
			});
			await store.approvals.create({
				agent: "test",
				callId: extraCall.id,
				channel: thread.channel,
				command: `deploy-${i}`,
				runtime: "host-bash",
				reason: "Deploy",
			});
		}

		const out = cli(["status", "--db", path, "--agent", "test", "--runtime-root", root]);
		assert.match(out, /ok: database ok/);
		assert.match(out, /ok: runtime root exists/);
		assert.match(out, /ok: app lock active/);
		assert.match(out, /turns: 1 running/);
		assert.match(out, /calls: 0 running, 102 pending approval/);
		assert.match(out, /approvals: 102 pending, 1 active bypasses/);
		assert.match(out, /jobs: 1 total, 1 active, 0 paused, 1 due/);
		const json = JSON.parse(cli(["status", "--db", path, "--agent", "test", "--json"])) as {
			agent: string;
			calls: { pendingApproval: number };
			jobs: { due: number };
			approvals: { pending: number; bypasses: number };
		};
		assert.equal(json.agent, "test");
		assert.equal(json.calls.pendingApproval, 102);
		assert.equal(json.jobs.due, 1);
		assert.deepEqual(json.approvals, { pending: 102, bypasses: 1 });
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("cli status reports pending migrations without applying them", async () => {
	const root = await mkdtemp(join(tmpdir(), "heypi-cli-status-pending-"));
	try {
		const path = join(root, "heypi.db");
		const out = cli(["status", "--db", path, "--agent", "test"]);
		assert.match(out, /warn: database migrations \d+ pending; run heypi db migrate --db /);
		assert.match(out, /warn: status unavailable until migrations are current/);
		const db = sqliteStore({ path });
		await assert.rejects(() =>
			db.threads.getOrCreate({ agent: "test", provider: "slack", channel: "C1", key: "C1" }),
		);
		const json = JSON.parse(cli(["status", "--db", path, "--agent", "test", "--json"])) as {
			database: { migrations: string; pending: string[] };
			status: string;
		};
		assert.equal(json.database.migrations, "pending");
		assert.ok(json.database.pending.length > 0);
		assert.equal(json.status, "unavailable");
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("cli prints Slack manifests by explicit mode", () => {
	const socket = cli(["slack", "manifest", "--mode", "socket"]);
	assert.match(socket, /socket_mode_enabled: true/);
	assert.doesNotMatch(socket, /request_url:/);
	assert.match(socket, /channels:read/);
	assert.match(socket, /usergroups:read/);
	assert.match(socket, /command: \/heypi/);
	assert.doesNotMatch(socket, /groups:history/);

	const http = cli(["slack", "manifest", "--mode", "http", "--url", "https://agent.example.com/slack/slack/events"]);
	assert.match(http, /socket_mode_enabled: false/);
	assert.match(http, /request_url: https:\/\/agent\.example\.com\/slack\/slack\/events/);
	assert.match(http, /channels:read/);
	assert.match(http, /usergroups:read/);
	assert.match(http, /command: \/heypi/);
	assert.doesNotMatch(http, /groups:history/);
});

test("cli requires Slack manifest mode", () => {
	assert.throws(() => cli(["slack", "manifest"]), /Missing --mode/);
});

test("cli Slack manifest supports a custom slash command", () => {
	const out = cli(["slack", "manifest", "--mode", "socket", "--command", "/opsbot"]);
	assert.match(out, /command: \/opsbot/);
	assert.doesNotMatch(out, /command: \/heypi/);
});

test("cli Discord invite includes application commands scope", () => {
	const out = cli(["discord", "invite", "--client-id", "123"]);
	assert.match(out, /scope=bot%20applications\.commands/);
});

test("cli db migrate and jobs commands operate on sqlite store", async () => {
	const root = await mkdtemp(join(tmpdir(), "heypi-cli-jobs-"));
	try {
		const path = join(root, "heypi.db");
		assert.match(cli(["db", "migrate", "--db", path]), /ok: database migrated/);
		assert.match(cli(["jobs", "list", "--db", path]), /No jobs found/);

		const store = sqliteStore({ path });
		await store.setup();
		await store.jobs?.upsert({
			id: "daily",
			agent: "test",
			kind: "heartbeat",
			schedule: JSON.stringify({ everyMs: 60_000 }),
			prompt: "check in",
			state: "active",
			nextAt: Date.now() + 60_000,
		});

		const list = cli(["jobs", "list", "--db", path]);
		assert.match(list, /agent\s+id\s+kind\s+state/);
		assert.match(list, /test\s+daily\s+heartbeat\s+active/);
		assert.match(cli(["jobs", "show", "daily", "--db", path, "--agent", "test"]), /id: daily/);
		const json = JSON.parse(cli(["jobs", "list", "--db", path, "--json"])) as Array<{ id: string }>;
		assert.deepEqual(
			json.map((job) => job.id),
			["daily"],
		);
		assert.match(cli(["jobs", "pause", "daily", "--db", path, "--agent", "test"]), /ok: job daily paused/);
		assert.equal((await store.jobs?.get({ agent: "test", id: "daily" }))?.state, "paused");
		assert.match(cli(["jobs", "resume", "daily", "--db", path, "--agent", "test"]), /ok: job daily active/);
		assert.equal((await store.jobs?.get({ agent: "test", id: "daily" }))?.state, "active");
		assert.match(cli(["jobs", "run", "daily", "--db", path, "--agent", "test"]), /marked due/);
		const job = await store.jobs?.get({ agent: "test", id: "daily" });
		assert.ok(job?.nextAt && job.nextAt <= Date.now());
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("cli approvals commands inspect pending approvals", async () => {
	const root = await mkdtemp(join(tmpdir(), "heypi-cli-approvals-"));
	try {
		const path = join(root, "heypi.db");
		assert.match(cli(["db", "migrate", "--db", path]), /ok: database migrated/);
		assert.match(cli(["approvals", "list", "--db", path]), /No pending approvals/);
		assert.match(cli(["approvals", "bypasses", "--db", path]), /No active approval bypasses/);

		const store = sqliteStore({ path });
		await store.setup();
		const approval = await store.approvals.create({
			agent: "test",
			callId: "call-1",
			channel: "slack:T1:C1",
			command: "hosts_upsert",
			runtime: "tool",
			reason: "Add host",
			requestedBy: "U1",
		});
		const bypass = await store.approvalBypasses?.create({
			agent: "test",
			scope: "thread",
			channel: "slack:T1:C1",
			threadId: "thread-1",
			actor: "U1",
			createdBy: "U_ALLOWED",
			reason: "Add host",
			approvalId: approval.id,
			expiresAt: Date.now() + 60_000,
		});
		assert.ok(bypass);

		assert.match(cli(["approvals", "list", "--db", path]), new RegExp(approval.id));
		assert.match(cli(["approvals", "show", approval.id, "--db", path]), /reason: Add host/);
		assert.match(cli(["approvals", "bypasses", "--db", path, "--agent", "test"]), new RegExp(bypass.id));
		const json = JSON.parse(cli(["approvals", "list", "--db", path, "--json"])) as Array<{ id: string }>;
		assert.deepEqual(
			json.map((row) => row.id),
			[approval.id],
		);
		const bypassJson = JSON.parse(cli(["approvals", "bypasses", "--db", path, "--json"])) as Array<{ id: string }>;
		assert.deepEqual(
			bypassJson.map((row) => row.id),
			[bypass.id],
		);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("cli admin link signs a URL from admin state", async () => {
	const root = await mkdtemp(join(tmpdir(), "heypi-cli-admin-"));
	try {
		const state = join(root, "state");
		const admin = join(state, "admin");
		await mkdir(admin, { recursive: true });
		const secret = "admin-signing-secret-with-enough-length-123";
		const instanceId = "admin-instance-for-cli-test";
		const probe = await startAdminProbe(instanceId);
		await writeFile(join(admin, "secret"), `${secret}\n`, { encoding: "utf8", mode: 0o600 });
		try {
			await writeAdminDescriptor(admin, process.pid, probe.url, root, instanceId);
			const out = (await cliAsync(["admin", "link", "--state", state])).trim();
			const url = new URL(out);
			assert.equal(url.origin, probe.url);
			assert.equal(url.pathname, "/admin/login");
			const token = url.searchParams.get("t");
			assert.ok(token);
			assert.equal(verifyAdminLoginToken(secret, token, { stateRoot: state }).ok, true);
			assert.equal(verifyAdminLoginToken(secret, token, { stateRoot: join(root, "other-state") }).ok, false);
		} finally {
			await closeServer(probe.server);
		}
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("cli admin link explains missing running admin server", async () => {
	const root = await mkdtemp(join(tmpdir(), "heypi-cli-admin-down-"));
	try {
		const state = join(root, "state");
		await mkdir(join(state, "admin"), { recursive: true });
		await writeFile(join(state, "admin", "secret"), "admin-signing-secret-with-enough-length-123\n", {
			encoding: "utf8",
			mode: 0o600,
		});
		const result = spawnSync(process.execPath, [CLI, "admin", "link", "--state", state], {
			cwd: process.cwd(),
			encoding: "utf8",
		});
		assert.notEqual(result.status, 0);
		assert.match(result.stderr, /no running admin server found/);
		assert.match(result.stderr, /start heypi/);
		assert.doesNotMatch(result.stderr, /admin-signing-secret/);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("cli admin link requires an explicit state root when no admin state is discoverable", async () => {
	const root = await mkdtemp(join(tmpdir(), "heypi-cli-admin-no-state-"));
	try {
		const result = spawnSync(process.execPath, [CLI, "admin", "link", "--url", "http://127.0.0.1:3000"], {
			cwd: root,
			env: { ...process.env, HEYPI_ADMIN_SECRET: "admin-signing-secret-with-enough-length-123", INIT_CWD: root },
			encoding: "utf8",
		});
		assert.notEqual(result.status, 0);
		assert.match(result.stderr, /no heypi admin state found/);
		assert.match(result.stderr, /pass --state/);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("cli admin link rejects stale descriptors with the wrong admin instance", async () => {
	const root = await mkdtemp(join(tmpdir(), "heypi-cli-admin-stale-instance-"));
	try {
		const state = join(root, "state");
		const admin = join(state, "admin");
		await mkdir(admin, { recursive: true });
		await writeFile(join(admin, "secret"), "admin-signing-secret-with-enough-length-123\n", {
			encoding: "utf8",
			mode: 0o600,
		});
		const probe = await startAdminProbe("different-instance");
		try {
			const descriptor = await writeAdminDescriptor(admin, process.pid, probe.url, root, "expected-instance");
			await assert.rejects(() => cliAsync(["admin", "link", "--state", state]), /no running admin server found/);
			await assert.rejects(() => access(descriptor));
		} finally {
			await closeServer(probe.server);
		}
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("cli admin link keeps descriptors when the admin instance is temporarily unreachable", async () => {
	const root = await mkdtemp(join(tmpdir(), "heypi-cli-admin-probe-timeout-"));
	try {
		const state = join(root, "state");
		const admin = join(state, "admin");
		await mkdir(admin, { recursive: true });
		await writeFile(join(admin, "secret"), "admin-signing-secret-with-enough-length-123\n", {
			encoding: "utf8",
			mode: 0o600,
		});
		const descriptor = await writeAdminDescriptor(
			admin,
			process.pid,
			"http://127.0.0.1:1",
			root,
			"temporarily-unreachable",
		);
		await assert.rejects(
			() => cliAsync(["admin", "link", "--state", state]),
			/found 1 admin server descriptor\(s\).*none responded/,
		);
		await assert.rejects(
			() => cliAsync(["admin", "link", "--state", state, "--pid", String(process.pid)]),
			/admin server pid \d+ was found.*but did not respond/,
		);
		await access(descriptor);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("cli admin link preserves descriptors when the probe response has no instance header", async () => {
	const root = await mkdtemp(join(tmpdir(), "heypi-cli-admin-probe-no-header-"));
	try {
		const state = join(root, "state");
		const admin = join(state, "admin");
		await mkdir(admin, { recursive: true });
		await writeFile(join(admin, "secret"), "admin-signing-secret-with-enough-length-123\n", {
			encoding: "utf8",
			mode: 0o600,
		});
		const probe = await startAdminProbe();
		try {
			const descriptor = await writeAdminDescriptor(admin, process.pid, probe.url, root, "expected-instance");
			await assert.rejects(
				() => cliAsync(["admin", "link", "--state", state]),
				/found 1 admin server descriptor\(s\).*none responded/,
			);
			await access(descriptor);
		} finally {
			await closeServer(probe.server);
		}
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("cli admin link lets --url override live descriptor discovery", async () => {
	const root = await mkdtemp(join(tmpdir(), "heypi-cli-admin-url-"));
	const child = spawn(process.execPath, ["-e", "setInterval(() => undefined, 1000)"], { stdio: "ignore" });
	const probe = await startAdminProbe("current");
	try {
		assert.ok(child.pid);
		const state = join(root, "state");
		const admin = join(state, "admin");
		await mkdir(admin, { recursive: true });
		await writeFile(join(admin, "secret"), "admin-signing-secret-with-enough-length-123\n", {
			encoding: "utf8",
			mode: 0o600,
		});
		await writeAdminDescriptor(admin, process.pid, "http://127.0.0.1:3000", root, "current");
		await writeAdminDescriptor(admin, child.pid, "http://127.0.0.1:3001", root, "child");
		const out = (await cliAsync(["admin", "link", "--state", state, "--url", probe.url])).trim();
		const url = new URL(out);
		assert.equal(url.origin, probe.url);
		assert.equal(url.pathname, "/admin/login");
		assert.ok(url.searchParams.get("t"));
	} finally {
		await closeServer(probe.server);
		child.kill();
		await rm(root, { recursive: true, force: true });
	}
});

test("cli admin link rejects --url when it does not match the descriptor instance", async () => {
	const root = await mkdtemp(join(tmpdir(), "heypi-cli-admin-url-mismatch-"));
	try {
		const state = join(root, "state");
		const admin = join(state, "admin");
		await mkdir(admin, { recursive: true });
		await writeFile(join(admin, "secret"), "admin-signing-secret-with-enough-length-123\n", {
			encoding: "utf8",
			mode: 0o600,
		});
		const probe = await startAdminProbe("other-instance");
		try {
			const descriptor = await writeAdminDescriptor(admin, process.pid, "http://127.0.0.1:3000", root, "expected");
			await assert.rejects(
				() => cliAsync(["admin", "link", "--state", state, "--url", probe.url]),
				/no admin server descriptor matched/,
			);
			await access(descriptor);
		} finally {
			await closeServer(probe.server);
		}
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("cli admin link requires --pid for multiple discovered admin servers", async () => {
	const root = await mkdtemp(join(tmpdir(), "heypi-cli-admin-pid-"));
	const child = spawn(process.execPath, ["-e", "setInterval(() => undefined, 1000)"], { stdio: "ignore" });
	const currentProbe = await startAdminProbe("current-instance");
	const childProbe = await startAdminProbe("child-instance");
	try {
		assert.ok(child.pid);
		const state = join(root, "state");
		const admin = join(state, "admin");
		await mkdir(admin, { recursive: true });
		await writeFile(join(admin, "secret"), "admin-signing-secret-with-enough-length-123\n", {
			encoding: "utf8",
			mode: 0o600,
		});
		await writeAdminDescriptor(admin, process.pid, currentProbe.url, root, "current-instance");
		await writeAdminDescriptor(admin, child.pid, childProbe.url, root, "child-instance");
		await assert.rejects(() => cliAsync(["admin", "link", "--state", state]), /multiple admin servers are running/);
		const out = (await cliAsync(["admin", "link", "--state", state, "--pid", String(child.pid)])).trim();
		assert.equal(new URL(out).origin, childProbe.url);
	} finally {
		child.kill();
		await closeServer(currentProbe.server);
		await closeServer(childProbe.server);
		await rm(root, { recursive: true, force: true });
	}
});

test("cli errors do not echo supplied provider tokens", () => {
	const token = "xoxb" + "-secret-token";
	const result = spawnSync(process.execPath, [CLI, "slack", "check", "--bot-token", token], {
		cwd: process.cwd(),
		encoding: "utf8",
	});
	assert.notEqual(result.status, 0);
	assert.doesNotMatch(result.stderr, /Missing --app-token or SLACK_APP_TOKEN/);
	assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, new RegExp(token));
});

test("document converter wrapper rejects invalid invocation", () => {
	const result = spawnSync(CONVERT_DOCUMENT, [], {
		cwd: process.cwd(),
		encoding: "utf8",
	});
	assert.notEqual(result.status, 0);
	assert.equal(result.stdout, "");
	assert.match(result.stderr, /expected exactly one local file path/);
});

test("document converter wrapper explains missing python3", () => {
	const result = spawnSync(CONVERT_DOCUMENT, [], {
		cwd: process.cwd(),
		encoding: "utf8",
		env: { ...process.env, PATH: "/nonexistent" },
	});
	assert.equal(result.status, 127);
	assert.equal(result.stdout, "");
	assert.match(result.stderr, /python3 is required/);
});

async function writeAdminDescriptor(
	admin: string,
	pid: number,
	url: string,
	project: string,
	instanceId: string,
): Promise<string> {
	const path = join(admin, `server.${pid}.json`);
	await writeFile(
		path,
		JSON.stringify({
			version: 1,
			pid,
			instanceId,
			hostname: "localhost",
			url,
			agent: "test",
			project,
			startedAt: new Date().toISOString(),
			adminPath: "/admin",
		}),
		"utf8",
	);
	return path;
}

async function startAdminProbe(instanceId?: string): Promise<{ server: Server; url: string }> {
	const server = createServer((_req, res) => {
		if (instanceId) res.writeHead(200, { "x-heypi-admin-instance": instanceId });
		else res.writeHead(200);
		res.end("ok");
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address() as AddressInfo;
	return { server, url: `http://127.0.0.1:${address.port}` };
}

async function closeServer(server: Server): Promise<void> {
	await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}

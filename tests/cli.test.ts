import assert from "node:assert/strict";
import { execFile, execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { sqliteStore } from "@hunvreus/heypi";

const CLI = resolve("dist/cli.js");
const CONVERT_DOCUMENT = resolve("bin/heypi-convert-document");

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
	assert.match(help, /heypi 0\.1\.0-alpha\.0/);
	assert.match(help, /heypi slack channels/);
	assert.equal(cli(["version"]).trim(), "0.1.0-alpha.0");
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

		assert.match(cli(["jobs", "list", "--db", path]), /daily\theartbeat\tactive/);
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

		const store = sqliteStore({ path });
		await store.setup();
		const approval = await store.approvals.create({
			callId: "call-1",
			channel: "slack:T1:C1",
			command: "hosts_upsert",
			runtime: "tool",
			reason: "Add host",
			requestedBy: "U1",
		});

		assert.match(cli(["approvals", "list", "--db", path]), new RegExp(approval.id));
		assert.match(cli(["approvals", "show", approval.id, "--db", path]), /reason: Add host/);
		const json = JSON.parse(cli(["approvals", "list", "--db", path, "--json"])) as Array<{ id: string }>;
		assert.deepEqual(
			json.map((row) => row.id),
			[approval.id],
		);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("cli admin link asks the running admin server for a one-time URL", async () => {
	const root = await mkdtemp(join(tmpdir(), "heypi-cli-admin-"));
	const token = "admin-control-token-with-enough-length-123";
	const login = "http://127.0.0.1:3000/admin/login?token=fresh";
	let sawRequest = false;
	const server = createServer((req, res) => {
		if (req.method !== "POST" || req.url !== "/admin/_control/links") {
			res.writeHead(404);
			res.end();
			return;
		}
		sawRequest = true;
		if (req.headers.authorization !== `Bearer ${token}`) {
			res.writeHead(401, { "content-type": "application/json" });
			res.end(JSON.stringify({ error: "unauthorized" }));
			return;
		}
		res.writeHead(200, { "content-type": "application/json" });
		res.end(JSON.stringify({ url: login, expiresAt: Date.now() + 300_000 }));
	});
	try {
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const port = (server.address() as AddressInfo).port;
		const control = join(root, "admin-control.json");
		await writeFile(
			control,
			JSON.stringify({ token, url: `http://127.0.0.1:${port}`, createdAt: new Date().toISOString() }),
			"utf8",
		);
		assert.equal((await cliAsync(["admin", "link", "--control", control])).trim(), login);
		assert.equal(sawRequest, true);
	} finally {
		await new Promise<void>((resolve) => server.close(() => resolve()));
		await rm(root, { recursive: true, force: true });
	}
});

test("cli admin link explains unreachable admin server", async () => {
	const root = await mkdtemp(join(tmpdir(), "heypi-cli-admin-down-"));
	const token = "admin-control-token-with-enough-length-123";
	const server = createServer();
	let closed = false;
	try {
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const port = (server.address() as AddressInfo).port;
		await new Promise<void>((resolve) =>
			server.close(() => {
				closed = true;
				resolve();
			}),
		);
		const control = join(root, "admin-control.json");
		await writeFile(
			control,
			JSON.stringify({ token, url: `http://127.0.0.1:${port}`, createdAt: new Date().toISOString() }),
			"utf8",
		);
		const result = spawnSync(process.execPath, [CLI, "admin", "link", "--control", control], {
			cwd: process.cwd(),
			encoding: "utf8",
		});
		assert.notEqual(result.status, 0);
		assert.match(result.stderr, /admin server is not reachable/);
		assert.match(result.stderr, new RegExp(`127\\.0\\.0\\.1:${port}`));
		assert.match(result.stderr, /make sure the heypi process is running/);
		assert.doesNotMatch(result.stderr, new RegExp(token));
	} finally {
		if (!closed) await new Promise<void>((resolve) => server.close(() => resolve()));
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

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { sqliteStore } from "@hunvreus/heypi";

const CLI = resolve("dist/cli.js");

function cli(args: string[], input?: { env?: NodeJS.ProcessEnv; cwd?: string }): string {
	return execFileSync(process.execPath, [CLI, ...args], {
		cwd: input?.cwd ?? process.cwd(),
		env: { ...process.env, ...(input?.env ?? {}) },
		encoding: "utf8",
	});
}

test("cli prints help and version", () => {
	assert.match(cli(["help"]), /heypi 0\.1\.0-alpha\.0/);
	assert.equal(cli(["version"]).trim(), "0.1.0-alpha.0");
});

test("cli check loads env file and validates runtime root", async () => {
	const root = await mkdtemp(join(tmpdir(), "heypi-cli-check-"));
	try {
		const env = join(root, ".env");
		await writeFile(env, "OPENAI_API_KEY=sk-test\n", "utf8");
		const out = cli(["check", "--env", env, "--runtime-root", root]);
		assert.match(out, /ok: node /);
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
		const json = JSON.parse(cli(["jobs", "list", "--db", path, "--json"])) as Array<{ id: string }>;
		assert.deepEqual(
			json.map((job) => job.id),
			["daily"],
		);
		assert.match(cli(["jobs", "pause", "daily", "--db", path]), /ok: job daily paused/);
		assert.equal((await store.jobs?.get("daily"))?.state, "paused");
		assert.match(cli(["jobs", "resume", "daily", "--db", path]), /ok: job daily active/);
		assert.equal((await store.jobs?.get("daily"))?.state, "active");
		assert.match(cli(["jobs", "run", "daily", "--db", path]), /marked due/);
		const job = await store.jobs?.get("daily");
		assert.ok(job?.nextAt && job.nextAt <= Date.now());
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("cli errors do not echo supplied provider tokens", () => {
	const result = spawnSync(process.execPath, [CLI, "slack", "check", "--bot-token", "xoxb-secret-token"], {
		cwd: process.cwd(),
		encoding: "utf8",
	});
	assert.notEqual(result.status, 0);
	assert.match(result.stderr, /Missing --app-token or SLACK_APP_TOKEN/);
	assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /xoxb-secret-token/);
});

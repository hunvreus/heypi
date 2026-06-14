import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { agentFrom, consoleLogger, createHeypi, sqliteStore, workspace } from "@hunvreus/heypi";
import { nextAt } from "../src/core/schedule.js";
import { createScheduler, enqueueJobRuns } from "../src/core/scheduler.js";
import type { Adapter, AdapterTarget, Handler, Inbound, Outbound } from "../src/io/handler.js";
import type { SchedulerStore } from "../src/store/types.js";

test("nextAt anchors intervals and skips missed runs", () => {
	const next = nextAt({ everyMs: 10 }, 35, 0);
	assert.equal(next, 40);
});

test("nextAt resolves cron schedules in the future", () => {
	const next = nextAt({ cron: "*/5 * * * *", timezone: "UTC" }, Date.UTC(2026, 0, 1, 0, 1, 0));
	assert.equal(next, Date.UTC(2026, 0, 1, 0, 5, 0));
});

test("createHeypi installs configured jobs", async () => {
	const root = await mkdtemp(join(tmpdir(), "heypi-jobs-"));
	try {
		const store = sqliteStore({ path: join(root, "heypi.db") });
		const appAdapter = {
			name: "test",
			kind: "test",
			start: async () => undefined,
			send: async () => undefined,
			stop: async () => undefined,
		};
		const app = createHeypi({
			store,
			state: { root: join(root, "state") },
			logger: consoleLogger({ level: "error", format: "pretty" }),
			adapters: [appAdapter],
			agent: agentFrom("../../examples/telegram-workout/agent", { model: "openai/gpt-5-mini" }),
			runtime: { name: "just-bash", root: workspace(join(root, "workspace")) },
			jobs: [
				{
					id: "daily",
					kind: "heartbeat",
					everyMs: 24 * 60 * 60 * 1000,
					idleMs: 8 * 60 * 60 * 1000,
					scope: { test: {} },
					prompt: "check in",
				},
				{
					id: "cron",
					everyMs: 24 * 60 * 60 * 1000,
					targets: { test: { channels: ["C1"] } },
					prompt: "cron check",
				},
			],
		});
		await app.start();
		await app.stop();
		const job = await store.jobs?.get({ agent: "agent", id: "daily" });
		assert.equal(job?.kind, "heartbeat");
		assert.equal(job?.state, "active");
		assert.equal(job?.idleMs, 8 * 60 * 60 * 1000);
		assert.equal(job?.scope, JSON.stringify({ test: {} }));
		assert.ok(job?.nextAt);
		const cron = await store.jobs?.get({ agent: "agent", id: "cron" });
		assert.equal(cron?.target, JSON.stringify({ test: { channels: ["C1"] } }));
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("job store scopes job ids by agent", async () => {
	const root = await mkdtemp(join(tmpdir(), "heypi-jobs-agent-scope-"));
	try {
		const store = sqliteStore({ path: join(root, "heypi.db") });
		await store.setup();
		const now = Date.now();
		await store.jobs?.upsert({
			id: "daily",
			agent: "alpha",
			kind: "cron",
			schedule: JSON.stringify({ everyMs: 60_000 }),
			target: JSON.stringify({ test: { channels: ["C1"] } }),
			prompt: "alpha",
			state: "active",
			nextAt: now - 1,
		});
		await store.jobs?.upsert({
			id: "daily",
			agent: "beta",
			kind: "cron",
			schedule: JSON.stringify({ everyMs: 60_000 }),
			target: JSON.stringify({ test: { channels: ["C2"] } }),
			prompt: "beta",
			state: "active",
			nextAt: now - 1,
		});

		assert.equal((await store.jobs?.get({ agent: "alpha", id: "daily" }))?.prompt, "alpha");
		assert.equal((await store.jobs?.get({ agent: "beta", id: "daily" }))?.prompt, "beta");
		await assert.rejects(() => store.jobs?.get({ id: "daily" }) ?? Promise.resolve(), /job id is ambiguous/);
		assert.deepEqual(
			(await store.jobs?.due({ agent: "alpha", now }))?.map((job) => job.agent),
			["alpha"],
		);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("job upsert clears stale routing fields", async () => {
	const root = await mkdtemp(join(tmpdir(), "heypi-jobs-clear-route-"));
	try {
		const store = sqliteStore({ path: join(root, "heypi.db") });
		await store.setup();
		await store.jobs?.upsert({
			id: "follow-up",
			agent: "agent",
			kind: "heartbeat",
			schedule: JSON.stringify({ everyMs: 60_000 }),
			target: JSON.stringify({ test: { channels: ["C1"] } }),
			prompt: "targeted",
			state: "active",
			nextAt: Date.now() + 60_000,
			idleMs: 10_000,
		});
		await store.jobs?.upsert({
			id: "follow-up",
			agent: "agent",
			kind: "heartbeat",
			schedule: JSON.stringify({ everyMs: 60_000 }),
			scope: JSON.stringify({ test: { channels: ["C2"] } }),
			target: null,
			prompt: "scoped",
			state: "active",
			nextAt: Date.now() + 60_000,
			idleMs: null,
		});

		const row = await store.jobs?.get({ agent: "agent", id: "follow-up" });
		assert.equal(row?.target, null);
		assert.equal(row?.idleMs, null);
		assert.equal(row?.scope, JSON.stringify({ test: { channels: ["C2"] } }));
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("scheduler pauses removed config jobs and preserves manual pauses", async () => {
	const root = await mkdtemp(join(tmpdir(), "heypi-jobs-config-reconcile-"));
	try {
		const store = sqliteStore({ path: join(root, "heypi.db") });
		await store.setup();
		const first = createScheduler({
			agent: "agent",
			store,
			handler: handler(),
			adapters: [adapter()],
			starts: new Map(),
			logger: consoleLogger({ level: "error", format: "pretty" }),
			config: {
				jobs: [
					{ id: "keep", everyMs: 60_000, targets: { test: { channels: ["C1"] } }, prompt: "keep" },
					{ id: "remove", everyMs: 60_000, targets: { test: { channels: ["C1"] } }, prompt: "remove" },
				],
			},
		});
		await first?.start();
		await first?.stop();
		await store.jobs?.setState({ agent: "agent", id: "keep" }, "paused");

		const second = createScheduler({
			agent: "agent",
			store,
			handler: handler(),
			adapters: [adapter()],
			starts: new Map(),
			logger: consoleLogger({ level: "error", format: "pretty" }),
			config: {
				jobs: [{ id: "keep", everyMs: 60_000, targets: { test: { channels: ["C1"] } }, prompt: "keep" }],
			},
		});
		await second?.start();
		await second?.stop();

		assert.equal((await store.jobs?.get({ agent: "agent", id: "keep" }))?.state, "paused");
		assert.equal((await store.jobs?.get({ agent: "agent", id: "remove" }))?.state, "paused");
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("scheduler reconciles explicit empty job config", async () => {
	const root = await mkdtemp(join(tmpdir(), "heypi-jobs-empty-config-"));
	try {
		const store = sqliteStore({ path: join(root, "heypi.db") });
		await store.setup();
		await store.jobs?.upsert({
			id: "removed",
			agent: "agent",
			kind: "cron",
			schedule: JSON.stringify({ everyMs: 60_000 }),
			target: JSON.stringify({ test: { channels: ["C1"] } }),
			prompt: "removed",
			state: "active",
			nextAt: Date.now() + 60_000,
		});
		const scheduler = createScheduler({
			agent: "agent",
			store,
			handler: handler(),
			adapters: [adapter()],
			starts: new Map(),
			logger: consoleLogger({ level: "error", format: "pretty" }),
			config: { jobs: [] },
		});

		await scheduler?.start();
		await scheduler?.stop();

		assert.equal((await store.jobs?.get({ agent: "agent", id: "removed" }))?.state, "paused");
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("scheduler rejects cron jobs without explicit targets", async () => {
	const root = await mkdtemp(join(tmpdir(), "heypi-jobs-routes-"));
	try {
		const store = sqliteStore({ path: join(root, "heypi.db") });
		await store.setup();
		const scheduler = createScheduler({
			agent: "agent",
			store,
			handler: handler(),
			adapters: [adapter()],
			starts: new Map(),
			logger: consoleLogger({ level: "error", format: "pretty" }),
			config: { jobs: [{ id: "bad", everyMs: 60_000, prompt: "bad" }] },
		});
		assert.ok(scheduler);
		await assert.rejects(() => scheduler.start(), /cron job requires targets: bad/);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("scheduler sends cron jobs to explicit target channels", async () => {
	const root = await mkdtemp(join(tmpdir(), "heypi-jobs-targets-"));
	try {
		const store = sqliteStore({ path: join(root, "heypi.db") });
		await store.setup();
		const sent: Array<{ target: AdapterTarget; out: Outbound }> = [];
		const seen: Inbound[] = [];
		const scheduler = createScheduler({
			agent: "agent",
			store,
			handler: handler(seen),
			adapters: [adapter("test", sent)],
			starts: new Map(),
			logger: consoleLogger({ level: "error", format: "pretty" }),
			config: {
				pollMs: 5,
				jobs: [
					{
						id: "daily",
						everyMs: 60_000,
						targets: { test: { channels: ["C1", "C2"] } },
						prompt: "check",
					},
				],
			},
		});
		await scheduler?.start();
		await queueJob(store as SchedulerStore, "agent", "daily");
		await waitFor(() => sent.length === 2);
		await scheduler?.stop();
		assert.deepEqual(
			sent.map((row) => row.target.channel),
			["C1", "C2"],
		);
		assert.deepEqual(
			seen.map((row) => row.provider),
			["test", "test"],
		);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("scheduler runs queued targets concurrently up to maxConcurrentRuns", async () => {
	const root = await mkdtemp(join(tmpdir(), "heypi-jobs-concurrent-"));
	let release: (() => void) | undefined;
	try {
		const store = sqliteStore({ path: join(root, "heypi.db") });
		await store.setup();
		const sent: Array<{ target: AdapterTarget; out: Outbound }> = [];
		let active = 0;
		let maxActive = 0;
		const started: string[] = [];
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const blockingHandler: Handler = Object.assign(async (input: Inbound): Promise<Outbound> => {
			active++;
			maxActive = Math.max(maxActive, active);
			started.push(input.channel);
			await gate;
			active--;
			return { text: `ok ${input.channel}` };
		}, {});
		const scheduler = createScheduler({
			agent: "agent",
			store,
			handler: blockingHandler,
			adapters: [adapter("test", sent)],
			starts: new Map(),
			logger: consoleLogger({ level: "error", format: "pretty" }),
			config: {
				pollMs: 5,
				maxConcurrentRuns: 2,
				jobs: [
					{
						id: "parallel",
						everyMs: 60_000,
						targets: { test: { channels: ["C1", "C2"] } },
						prompt: "check",
					},
				],
			},
		});
		await scheduler?.start();
		await queueJob(store as SchedulerStore, "agent", "parallel");
		await waitFor(() => started.length === 2);

		assert.equal(maxActive, 2);
		release?.();
		await waitFor(() => sent.length === 2);
		await scheduler?.stop();
		assert.deepEqual(started.sort(), ["C1", "C2"]);
	} finally {
		release?.();
		await rm(root, { recursive: true, force: true });
	}
});

test("scheduler stop stops the loop without waiting for active queued runs", async () => {
	const root = await mkdtemp(join(tmpdir(), "heypi-jobs-stop-drain-"));
	let release: (() => void) | undefined;
	try {
		const store = sqliteStore({ path: join(root, "heypi.db") });
		await store.setup();
		const sent: Array<{ target: AdapterTarget; out: Outbound }> = [];
		let started = false;
		let stopped = false;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const blockingHandler: Handler = Object.assign(async (input: Inbound): Promise<Outbound> => {
			started = true;
			await gate;
			return { text: `ok ${input.channel}` };
		}, {});
		const scheduler = createScheduler({
			agent: "agent",
			store,
			handler: blockingHandler,
			adapters: [adapter("test", sent)],
			starts: new Map(),
			logger: consoleLogger({ level: "error", format: "pretty" }),
			config: {
				pollMs: 5,
				jobs: [
					{
						id: "drain",
						everyMs: 60_000,
						targets: { test: { channels: ["C1"] } },
						prompt: "drain",
					},
				],
			},
		});
		await scheduler?.start();
		await queueJob(store as SchedulerStore, "agent", "drain");
		await waitFor(() => started);

		const stop = scheduler?.stop().then(() => {
			stopped = true;
		});
		await waitFor(() => stopped);
		assert.equal(sent.length, 0);
		let drained = false;
		const drain = scheduler?.drain(1_000).then((result) => {
			drained = result;
		});
		await sleep(20);
		assert.equal(drained, false);
		release?.();
		await stop;
		await drain;
		await waitFor(() => sent.length === 1);

		assert.equal(stopped, true);
		assert.equal(drained, true);
		assert.equal(sent.length, 1);
		assert.equal((await store.jobRuns?.lastForJob({ agent: "agent", id: "drain" }))?.state, "done");
	} finally {
		release?.();
		await rm(root, { recursive: true, force: true });
	}
});

test("scheduler skips queued runs when the source job is gone", async () => {
	const root = await mkdtemp(join(tmpdir(), "heypi-jobs-gone-"));
	try {
		const store = sqliteStore({ path: join(root, "heypi.db") });
		await store.setup();
		await store.jobRuns?.create({
			jobAgent: "agent",
			jobId: "gone",
			trace: "job:agent:gone:1:C1",
			dueAt: Date.now(),
			targetKey: "C1:C1",
			adapter: "test",
			channel: "C1",
			threadKey: "C1:C1",
			target: JSON.stringify({ channel: "C1" }),
		});
		const sent: Array<{ target: AdapterTarget; out: Outbound }> = [];
		const scheduler = createScheduler({
			agent: "agent",
			store,
			handler: handler(),
			adapters: [adapter("test", sent)],
			starts: new Map(),
			logger: consoleLogger({ level: "error", format: "pretty" }),
			config: {
				pollMs: 5,
				jobs: [{ id: "keepalive", everyMs: 60_000, targets: { test: { channels: ["C1"] } }, prompt: "keep" }],
			},
		});

		await scheduler?.start();
		await waitFor(async () => (await store.jobRuns?.lastForJob({ agent: "agent", id: "gone" }))?.state === "skipped");
		await scheduler?.stop();

		const run = await store.jobRuns?.lastForJob({ agent: "agent", id: "gone" });
		assert.equal(run?.output, "job removed");
		assert.deepEqual(sent, []);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("scheduler still executes queued runs for paused jobs", async () => {
	const root = await mkdtemp(join(tmpdir(), "heypi-jobs-paused-queued-"));
	try {
		const store = sqliteStore({ path: join(root, "heypi.db") });
		await store.setup();
		await store.jobs?.upsert({
			id: "paused",
			agent: "agent",
			kind: "cron",
			schedule: JSON.stringify({ everyMs: 60_000 }),
			target: JSON.stringify({ test: { channels: ["C1"] } }),
			prompt: "paused queued",
			state: "paused",
			nextAt: Date.now() + 60_000,
		});
		await store.jobRuns?.create({
			jobAgent: "agent",
			jobId: "paused",
			trace: "job:agent:paused:1:C1",
			dueAt: Date.now(),
			targetKey: "C1:C1",
			adapter: "test",
			channel: "C1",
			threadKey: "C1:C1",
			target: JSON.stringify({ channel: "C1" }),
		});
		const sent: Array<{ target: AdapterTarget; out: Outbound }> = [];
		const seen: Inbound[] = [];
		const scheduler = createScheduler({
			agent: "agent",
			store,
			handler: handler(seen),
			adapters: [adapter("test", sent)],
			starts: new Map(),
			logger: consoleLogger({ level: "error", format: "pretty" }),
			config: {
				pollMs: 5,
				jobs: [{ id: "paused", everyMs: 60_000, targets: { test: { channels: ["C1"] } }, prompt: "paused queued" }],
			},
		});

		await scheduler?.start();
		await waitFor(() => sent.length === 1);
		await scheduler?.stop();

		const run = await store.jobRuns?.lastForJob({ agent: "agent", id: "paused" });
		assert.equal(run?.state, "done");
		assert.equal(seen[0]?.text, "paused queued");
		assert.equal((await store.jobs?.get({ agent: "agent", id: "paused" }))?.state, "paused");
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("scheduler clears one-shot jobs after they run", async () => {
	const root = await mkdtemp(join(tmpdir(), "heypi-jobs-once-"));
	try {
		const store = sqliteStore({ path: join(root, "heypi.db") });
		await store.setup();
		const at = Date.now() - 1_000;
		await store.jobs?.upsert({
			id: "once",
			agent: "agent",
			kind: "cron",
			schedule: JSON.stringify({ at }),
			target: JSON.stringify({ test: { channels: ["C1"] } }),
			prompt: "once",
			state: "active",
			nextAt: at,
		});
		const sent: Array<{ target: AdapterTarget; out: Outbound }> = [];
		const scheduler = createScheduler({
			agent: "agent",
			store,
			handler: handler(),
			adapters: [adapter("test", sent)],
			starts: new Map(),
			logger: consoleLogger({ level: "error", format: "pretty" }),
			config: {
				pollMs: 5,
				jobs: [
					{ id: "once", kind: "cron", schedule: { at }, targets: { test: { channels: ["C1"] } }, prompt: "once" },
				],
			},
		});

		await scheduler?.start();
		await waitFor(() => sent.length === 1);
		await scheduler?.stop();

		const job = await store.jobs?.get({ agent: "agent", id: "once" });
		assert.equal(job?.nextAt, null);
		assert.deepEqual(await store.jobs?.due({ agent: "agent", now: Date.now() + 60_000 }), []);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("scheduler fans heartbeat jobs out over scoped known threads", async () => {
	const root = await mkdtemp(join(tmpdir(), "heypi-jobs-scope-"));
	try {
		const store = sqliteStore({ path: join(root, "heypi.db") });
		await store.setup();
		await store.threads.getOrCreate({
			agent: "agent",
			provider: "test",
			channel: "C1",
			actor: "U1",
			key: "C1:111.222",
		});
		await store.threads.getOrCreate({
			agent: "agent",
			provider: "test",
			channel: "C2",
			actor: "U2",
			key: "C2:333.444",
		});
		const sent: Array<{ target: AdapterTarget; out: Outbound }> = [];
		const scheduler = createScheduler({
			agent: "agent",
			store,
			handler: handler(),
			adapters: [adapter("test", sent)],
			starts: new Map(),
			logger: consoleLogger({ level: "error", format: "pretty" }),
			config: {
				pollMs: 5,
				jobs: [
					{
						id: "follow-up",
						kind: "heartbeat",
						everyMs: 60_000,
						scope: { test: { channels: ["C1"] } },
						prompt: "follow up",
					},
				],
			},
		});
		await scheduler?.start();
		await queueJob(store as SchedulerStore, "agent", "follow-up");
		await waitFor(() => sent.length === 1);
		await scheduler?.stop();
		assert.equal(sent[0]?.target.channel, "C1");
		assert.equal(sent[0]?.target.thread, "111.222");
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("scheduler skips overlapping heartbeat runs for the same stored thread", async () => {
	const root = await mkdtemp(join(tmpdir(), "heypi-jobs-heartbeat-overlap-"));
	try {
		const store = sqliteStore({ path: join(root, "heypi.db") });
		await store.setup();
		await store.threads.getOrCreate({
			agent: "agent",
			provider: "test",
			channel: "C1",
			actor: "U1",
			key: "C1:111.222",
		});
		await store.jobs?.upsert({
			id: "follow-up",
			agent: "agent",
			kind: "heartbeat",
			schedule: JSON.stringify({ everyMs: 60_000 }),
			scope: JSON.stringify({ test: { channels: ["C1"] } }),
			prompt: "follow up",
			state: "active",
			nextAt: Date.now() + 60_000,
		});
		const job = await store.jobs?.get({ agent: "agent", id: "follow-up" });
		if (!job) throw new Error("missing heartbeat job");

		const first = await enqueueJobRuns({
			agent: "agent",
			store: store as SchedulerStore,
			job,
			dueAt: Date.now(),
			skipActiveHeartbeat: true,
		});
		const second = await enqueueJobRuns({
			agent: "agent",
			store: store as SchedulerStore,
			job,
			dueAt: Date.now() + 60_000,
			skipActiveHeartbeat: true,
		});

		assert.deepEqual(first, { targets: 1, inserted: 1, skipped: 0 });
		assert.deepEqual(second, { targets: 1, inserted: 0, skipped: 1 });
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("scheduler pauses malformed persisted job config", async () => {
	const root = await mkdtemp(join(tmpdir(), "heypi-jobs-malformed-"));
	let scheduler: ReturnType<typeof createScheduler> | undefined;
	try {
		const store = sqliteStore({ path: join(root, "heypi.db") });
		await store.setup();
		scheduler = createScheduler({
			agent: "agent",
			store,
			handler: handler(),
			adapters: [adapter()],
			starts: new Map(),
			logger: consoleLogger({ level: "error", format: "pretty" }),
			config: {
				pollMs: 5,
				jobs: [{ id: "keep", everyMs: 60_000, targets: { test: { channels: ["C1"] } }, prompt: "keep" }],
			},
		});
		await scheduler?.start();
		await store.jobs?.upsert({
			id: "bad",
			agent: "agent",
			kind: "cron",
			schedule: "{",
			target: JSON.stringify({ test: { channels: ["C1"] } }),
			prompt: "bad",
			state: "active",
			nextAt: Date.now() - 1,
		});
		await waitFor(async () => (await store.jobs?.get({ agent: "agent", id: "bad" }))?.state === "paused");
	} finally {
		await scheduler?.stop();
		await rm(root, { recursive: true, force: true });
	}
});

function adapter(name = "test", sent: Array<{ target: AdapterTarget; out: Outbound }> = []): Adapter {
	return {
		name,
		kind: "test",
		start: async () => undefined,
		send: async (target, out) => {
			sent.push({ target, out });
		},
		stop: async () => undefined,
	};
}

function handler(seen: Inbound[] = []): Handler {
	return Object.assign(async (input: Inbound): Promise<Outbound> => {
		seen.push(input);
		return { text: `ok ${input.channel}` };
	}, {});
}

async function queueJob(store: SchedulerStore, agent: string, id: string): Promise<void> {
	const job = await store.jobs.get({ agent, id });
	if (!job) throw new Error(`missing test job: ${id}`);
	await enqueueJobRuns({ agent, store, job, dueAt: Date.now() });
}

async function waitFor(done: () => boolean | Promise<boolean>): Promise<void> {
	const deadline = Date.now() + 1000;
	while (!(await done())) {
		if (Date.now() > deadline) throw new Error("Timed out waiting for scheduler");
		await sleep(10);
	}
}

async function sleep(ms: number): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, ms));
}

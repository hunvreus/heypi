import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { defineSchedule, loadSchedules, validateSchedule } from "../src/schedule.js";
import { createScheduleStore } from "../src/schedule-store.js";
import { createScheduler } from "../src/scheduler.js";

async function makeDir(name: string): Promise<string> {
	const root = join(tmpdir(), `heypi-${name}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	await mkdir(root, { recursive: true });
	return root;
}

const logger = {
	debug() {},
	info() {},
	warn() {},
	error() {},
};

describe("schedules", () => {
	it("discovers code-owned schedules by path", async () => {
		const root = await makeDir("schedule-load");
		await mkdir(join(root, "schedules", "reports"), { recursive: true });
		await writeFile(
			join(root, "schedules", "reports", "daily.ts"),
			`const prompt: string = "Report.";
			export default { cron: "0 9 * * *", timezone: "America/Los_Angeles", prompt };`,
		);

		const schedules = await loadSchedules(root);

		expect(schedules).toHaveLength(1);
		expect(schedules[0]).toMatchObject({
			id: "reports/daily",
			definition: { cron: "0 9 * * *", timezone: "America/Los_Angeles", prompt: "Report." },
		});
		expect(schedules[0]?.hash).toMatch(/^[a-f0-9]{64}$/);
	});

	it("rejects duplicate path-derived schedule ids", async () => {
		const root = await makeDir("schedule-duplicate");
		await mkdir(join(root, "schedules"), { recursive: true });
		const source = `export default { cron: "0 9 * * *", timezone: "UTC", prompt: "Report." };`;
		await writeFile(join(root, "schedules", "daily.js"), source);
		await writeFile(join(root, "schedules", "daily.ts"), source);

		await expect(loadSchedules(root)).rejects.toThrow("Duplicate schedule id daily");
	});

	it("includes declared dependencies in the definition hash", async () => {
		const root = await makeDir("schedule-dependency");
		await mkdir(join(root, "schedules"), { recursive: true });
		await writeFile(join(root, "schedules", "prompt.md"), "First prompt.\n");
		await writeFile(
			join(root, "schedules", "daily.ts"),
			`export default { cron: "0 9 * * *", timezone: "UTC", prompt: "Report.", dependencies: ["./prompt.md"] };`,
		);
		const first = await loadSchedules(root);
		await writeFile(join(root, "schedules", "prompt.md"), "Changed prompt.\n");
		const second = await loadSchedules(root);

		expect(second[0]?.hash).not.toBe(first[0]?.hash);
	});

	it("reloads changed schedule modules without stale module state", async () => {
		const root = await makeDir("schedule-reload");
		await mkdir(join(root, "schedules"), { recursive: true });
		const path = join(root, "schedules", "daily.ts");
		await writeFile(path, `export default { cron: "0 9 * * *", timezone: "UTC", prompt: "First." };`);
		const first = await loadSchedules(root);
		await writeFile(path, `export default { cron: "0 9 * * *", timezone: "UTC", prompt: "Second." };`);
		const second = await loadSchedules(root);

		expect(first[0]?.definition.prompt).toBe("First.");
		expect(second[0]?.definition.prompt).toBe("Second.");
		expect(second[0]?.hash).not.toBe(first[0]?.hash);
	});

	it("validates five-field cron schedules with one execution form", () => {
		expect(() => validateSchedule("bad", { cron: "0 0 9 * * *", timezone: "UTC", prompt: "Report." })).toThrow(
			"five-field",
		);
		expect(() =>
			validateSchedule("bad", defineSchedule({ cron: "0 9 * * *", timezone: "Not/AZone", prompt: "Report." })),
		).toThrow("Invalid timezone");
	});

	it("persists claims and marks interrupted runs failed on restart", async () => {
		const root = await makeDir("schedule-store");
		const path = join(root, "state.json");
		const store = createScheduleStore(path);
		await store.load();
		const claim = await store.claim("daily", "2026-07-14T09:00:00.000Z", "2026-07-14T09:00:01.000Z");
		expect(claim).toMatchObject({ action: "claimed", run: { status: "claimed" } });
		await expect(store.claim("daily", "2026-07-14T09:00:00.000Z", new Date().toISOString())).resolves.toMatchObject({
			action: "existing",
		});
		await expect(store.claim("daily", "2026-07-15T09:00:00.000Z", new Date().toISOString())).resolves.toEqual({
			action: "active",
		});

		const restored = createScheduleStore(path);
		await restored.load();

		expect(restored.runs("daily")[0]).toMatchObject({
			status: "failed",
			error: "interrupted by restart",
		});
		expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({ version: 1 });
	});

	it("does not expose schedule mutations that fail to persist", async () => {
		const root = await makeDir("schedule-write-failure");
		const path = join(root, "state.json");
		const store = createScheduleStore(path);
		await store.load();
		await rm(root, { recursive: true });
		await writeFile(root, "not a directory");

		await expect(store.claim("daily", "2026-07-14T09:00:00.000Z", "2026-07-14T09:00:01.000Z")).rejects.toThrow();
		expect(store.active("daily")).toBe(false);

		await rm(root);
		await expect(store.claim("daily", "2026-07-14T09:00:00.000Z", "2026-07-14T09:00:01.000Z")).resolves.toMatchObject(
			{ action: "claimed", run: { status: "claimed" } },
		);
	});

	it("rejects terminal run regressions", async () => {
		const root = await makeDir("schedule-terminal");
		const store = createScheduleStore(join(root, "state.json"));
		await store.load();
		const claim = await store.claim("daily", "2026-07-14T09:00:00.000Z", "2026-07-14T09:00:01.000Z");
		if (claim.action !== "claimed") throw new Error("expected run");
		const run = claim.run;
		await store.update(run.id, { status: "completed", finishedAt: new Date().toISOString() });

		await expect(store.update(run.id, { status: "failed" })).rejects.toThrow("completed -> failed");
		await expect(store.update(run.id, { output: "late output" })).rejects.toThrow("terminal schedule run");
	});

	it("retains only the latest 100 terminal runs per schedule", async () => {
		const root = await makeDir("schedule-retention");
		const store = createScheduleStore(join(root, "state.json"));
		await store.load();
		for (let index = 0; index < 105; index++) {
			const scheduledFor = new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString();
			const claim = await store.claim("daily", scheduledFor, scheduledFor);
			if (claim.action !== "claimed") throw new Error("expected run");
			const run = claim.run;
			await store.update(run.id, { status: "completed", finishedAt: scheduledFor });
		}

		const runs = store.runs("daily");
		expect(runs).toHaveLength(100);
		expect(runs[0]?.scheduledFor).toBe(new Date(Date.UTC(2026, 0, 1, 0, 5)).toISOString());
	});

	it("bounds shutdown when schedule execution ignores cancellation", async () => {
		const root = await makeDir("scheduler-shutdown");
		const store = createScheduleStore(join(root, "state.json"));
		const warnings: string[] = [];
		let release: (() => void) | undefined;
		let started: (() => void) | undefined;
		const executionStarted = new Promise<void>((resolve) => {
			started = resolve;
		});
		const scheduler = createScheduler({
			definitions: [
				{
					id: "slow",
					path: "/slow.ts",
					hash: "slow",
					definition: defineSchedule({ cron: "0 0 1 1 *", timezone: "UTC", prompt: "Wait." }),
				},
			],
			store,
			logger: {
				...logger,
				warn(event) {
					warnings.push(event);
				},
			},
			async dispatch() {
				return { jobId: "unused" };
			},
			async executePrompt() {
				started?.();
				await new Promise<void>((resolve) => {
					release = resolve;
				});
				return {};
			},
			shutdownGraceMs: 5,
			misfireGraceMs: -1,
		});
		await scheduler.start();
		await scheduler.run("slow");
		await executionStarted;

		await scheduler.stop();
		expect(warnings).toContain("scheduler_stop_timeout");
		release?.();
		for (let attempt = 0; attempt < 20 && store.runs("slow")[0]?.status !== "canceled"; attempt++) {
			await new Promise((resolve) => setTimeout(resolve, 5));
		}
		expect(store.runs("slow")[0]?.status).toBe("canceled");
	});

	it("skips a second occurrence while the same schedule is active", async () => {
		const root = await makeDir("scheduler-overlap");
		const store = createScheduleStore(join(root, "state.json"));
		let release: (() => void) | undefined;
		let started: (() => void) | undefined;
		const executionStarted = new Promise<void>((resolve) => {
			started = resolve;
		});
		const scheduler = createScheduler({
			definitions: [
				{
					id: "slow",
					path: "/slow.ts",
					hash: "slow",
					definition: defineSchedule({ cron: "0 0 1 1 *", timezone: "UTC", prompt: "Wait." }),
				},
			],
			store,
			logger,
			async dispatch() {
				return { jobId: "unused" };
			},
			async executePrompt() {
				started?.();
				await new Promise<void>((resolve) => {
					release = resolve;
				});
				return { output: "Done." };
			},
		});
		await scheduler.start();
		const first = await scheduler.run("slow");
		await executionStarted;

		const second = await scheduler.run("slow");
		expect(second).toMatchObject({ status: "skipped", error: "previous run still active" });

		release?.();
		expect(first).toMatchObject({ status: "claimed" });
		for (
			let attempt = 0;
			attempt < 20 && store.runs("slow").find((run) => run.id === first.id)?.status !== "completed";
			attempt++
		) {
			await new Promise((resolve) => setTimeout(resolve, 5));
		}
		expect(store.runs("slow").find((run) => run.id === first.id)).toMatchObject({ status: "completed" });
		await scheduler.stop();
	});

	it("preserves a dispatched run when its handler later throws", async () => {
		const root = await makeDir("scheduler-dispatched-error");
		const store = createScheduleStore(join(root, "state.json"));
		const scheduler = createScheduler({
			definitions: [
				{
					id: "dispatch",
					path: "/dispatch.ts",
					hash: "dispatch",
					definition: defineSchedule({
						cron: "0 0 1 1 *",
						timezone: "UTC",
						async run({ dispatch }) {
							await dispatch({ prompt: "Run.", target: { adapterId: "local", conversation: "reports" } });
							throw new Error("handler failed after dispatch");
						},
					}),
				},
			],
			store,
			logger,
			async dispatch() {
				return { jobId: "job-1" };
			},
			async executePrompt() {
				return {};
			},
		});
		await scheduler.start();
		const claimed = await scheduler.run("dispatch");
		for (let attempt = 0; attempt < 20 && store.runs("dispatch")[0]?.status === "claimed"; attempt++) {
			await new Promise((resolve) => setTimeout(resolve, 5));
		}

		expect(claimed.status).toBe("claimed");
		expect(store.runs("dispatch")[0]).toMatchObject({ status: "dispatched", jobId: "job-1" });
		await scheduler.stop();
	});
});

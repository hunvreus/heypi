import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { type Adapter, agentFrom, consoleLogger, createHeypi, sqliteStore, workspace } from "@hunvreus/heypi";
import { nextAt } from "../src/core/schedule.js";

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
		const adapter: Adapter = {
			name: "test",
			start: async () => undefined,
			send: async () => undefined,
			stop: async () => undefined,
		};
		const app = createHeypi({
			store,
			logger: consoleLogger({ level: "error", format: "pretty" }),
			adapters: [adapter],
			agent: agentFrom("./examples/telegram-workout/agent", { model: "openai/gpt-5-mini" }),
			runtime: { name: "just-bash", root: workspace(join(root, "workspace")) },
			jobs: [
				{
					id: "daily",
					kind: "heartbeat",
					everyMs: 24 * 60 * 60 * 1000,
					idleMs: 8 * 60 * 60 * 1000,
					scope: { adapters: ["test"] },
					prompt: "check in",
				},
			],
		});
		await app.start();
		await app.stop();
		const job = await store.jobs?.get("daily");
		assert.equal(job?.kind, "heartbeat");
		assert.equal(job?.state, "active");
		assert.equal(job?.idleMs, 8 * 60 * 60 * 1000);
		assert.equal(job?.scope, JSON.stringify({ adapters: ["test"] }));
		assert.ok(job?.nextAt);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

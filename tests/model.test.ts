import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { CallRunner } from "../src/core/calls.js";
import { createHandler } from "../src/io/handler.js";
import type { AgentReq } from "../src/runtime/agent.js";
import { Queue } from "../src/runtime/queue.js";
import { sqliteStore } from "../src/store/sqlite.js";

async function tempDb(): Promise<{ path: string; cleanup: () => Promise<void> }> {
	const dir = await mkdtemp(join(tmpdir(), "heypi-model-"));
	return { path: join(dir, "store.db"), cleanup: () => rm(dir, { recursive: true, force: true }) };
}

test("handler passes per-turn model override to agent", async () => {
	const db = await tempDb();
	try {
		const store = sqliteStore({ path: db.path });
		await store.setup();
		let request: AgentReq | undefined;
		const handler = createHandler({
			agentId: "a",
			store,
			callRunner: new CallRunner(store.calls, store.approvals, new Queue({}), {
				name: "host-bash",
				root: ".",
				capabilities: {},
			}),
			agent: {
				ask: async (req) => {
					request = req;
					return { text: "ok" };
				},
				continue: async () => ({ text: "ok" }),
			},
		});

		await handler({
			trace: "trace-1",
			provider: "test",
			eventId: "event-1",
			channel: "C1",
			actor: "U1",
			thread: "T1",
			text: "hello",
			model: { provider: "openai", name: "gpt-5.5" },
		});

		assert.deepEqual(request?.model, { provider: "openai", name: "gpt-5.5" });
	} finally {
		await db.cleanup();
	}
});

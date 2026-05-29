import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Agent } from "../src/runtime/agent.js";
import { sqliteStore } from "../src/store/sqlite.js";
import { continueTool, saveReply } from "../src/store/transcript.js";

test("continueTool passes Pi session route to the agent", async () => {
	const root = await mkdtemp(join(tmpdir(), "heypi-transcript-"));
	try {
		const store = sqliteStore({ path: join(root, "heypi.db") });
		await store.setup();
		const thread = await store.threads.getOrCreate({
			agent: "a",
			provider: "test",
			channel: "C1",
			key: "T1",
		});
		let request: Awaited<Parameters<Agent["continue"]>[0]> | undefined;
		await continueTool({
			store,
			agent: {
				ask: async () => ({ text: "unused" }),
				continue: async (req) => {
					request = req;
					return { text: "ok" };
				},
			},
			provider: "test",
			channel: "C1",
			actor: "U1",
			trace: "trace-1",
			turn: "turn-1",
			continuation: {
				threadId: thread.id,
				toolCallId: "tool-call-1",
				tool: "bash",
				actor: "U_REQUESTER",
				out: "ok",
				err: "",
				isError: false,
			},
		});

		assert.equal(request?.threadId, thread.id);
		assert.equal(request?.sessionId, thread.sessionId);
		assert.equal(request?.sessionPath, thread.sessionPath);
		assert.equal(request?.actor, "U_REQUESTER");
		assert.equal(request?.continuation?.toolCallId, "tool-call-1");
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("continueTool throws when the thread route is missing", async () => {
	await assert.rejects(
		() =>
			continueTool({
				store: { threads: { get: async () => undefined } } as unknown as Parameters<
					typeof continueTool
				>[0]["store"],
				agent: { continue: async () => ({ text: "unused" }) } as unknown as Agent,
				provider: "test",
				channel: "C1",
				actor: "U1",
				trace: "trace-1",
				turn: "turn-1",
				continuation: {
					threadId: "thread-1",
					toolCallId: "tool-call-1",
					tool: "bash",
					out: "ok",
					err: "",
					isError: false,
				},
			}),
		/thread not found/,
	);
});

test("saveReply stores a single assistant audit row", async () => {
	const root = await mkdtemp(join(tmpdir(), "heypi-transcript-"));
	try {
		const store = sqliteStore({ path: join(root, "heypi.db") });
		await store.setup();
		const thread = await store.threads.getOrCreate({
			agent: "a",
			provider: "test",
			channel: "C1",
			key: "T1",
		});

		const row = await saveReply({
			store,
			threadId: thread.id,
			provider: "test",
			reply: { text: "done" },
		});

		assert.equal(row.role, "assistant");
		assert.equal(row.text, "done");
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

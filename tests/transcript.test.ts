import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Agent } from "../src/runtime/agent.js";
import { sqliteStore } from "../src/store/sqlite.js";
import { continueTool, decode, encode, messageText, saveReply } from "../src/store/transcript.js";
import type { Messages, Store, StoredMessage } from "../src/store/types.js";

test("transcript encode/decode preserves raw Pi tool result messages", () => {
	const message = {
		role: "toolResult",
		toolCallId: "tool-call-1",
		toolName: "delete_ticket",
		content: [{ type: "text", text: "deleted=T1" }],
		details: { state: "done" },
		isError: false,
		timestamp: 123,
	} as StoredMessage;

	assert.deepEqual(decode(encode(message, { trace: "trace-1" })), message);
	assert.equal(messageText(message), "deleted=T1");
});

test("continueTool throws when the pending tool result is missing", async () => {
	await assert.rejects(
		() =>
			continueTool({
				store: { messages: new EmptyMessages() } as unknown as Store,
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
		/tool result not found/,
	);
});

test("saveReply indexes tool result messages by tool call id", async () => {
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

		await saveReply({
			store,
			threadId: thread.id,
			provider: "test",
			reply: {
				text: "",
				messages: [
					{
						role: "toolResult",
						toolCallId: "tool-call-1",
						toolName: "lookup",
						content: [{ type: "text", text: "ok" }],
						timestamp: 123,
					} as StoredMessage,
				],
			},
		});

		const found = await store.messages.getToolResult(thread.id, "tool-call-1");
		assert.equal(found?.toolCallId, "tool-call-1");
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

class EmptyMessages implements Partial<Messages> {
	async getToolResult() {
		return undefined;
	}
}

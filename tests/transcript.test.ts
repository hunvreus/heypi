import assert from "node:assert/strict";
import { test } from "node:test";
import { decode, encode, messageText } from "../src/store/transcript.js";
import type { StoredMessage } from "../src/store/types.js";

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

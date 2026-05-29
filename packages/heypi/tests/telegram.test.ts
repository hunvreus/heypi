import assert from "node:assert/strict";
import { test } from "node:test";
import { parseTelegramCallback, telegramApprovalText, telegramChunks } from "../src/io/telegram.js";

test("parseTelegramCallback parses control actions", () => {
	assert.deepEqual(parseTelegramCallback("approve:abc"), { kind: "approve", id: "abc" });
	assert.deepEqual(parseTelegramCallback("deny:def"), { kind: "deny", id: "def" });
	assert.deepEqual(parseTelegramCallback("cancel:trace-1"), { kind: "cancel", id: "trace-1" });
	assert.deepEqual(parseTelegramCallback("status"), { kind: "status" });
	assert.equal(parseTelegramCallback("unknown:abc"), undefined);
	assert.equal(parseTelegramCallback("approve:"), undefined);
});

test("telegramChunks keeps markup chunks under Telegram edit limits", () => {
	const text = "a".repeat(3900);
	const chunks = telegramChunks(text, true);

	assert.equal(chunks.length, 2);
	assert.equal(
		chunks.every((chunk) => chunk.length <= 3800),
		true,
	);
});

test("Telegram approval resolution preserves approval text and appends status", () => {
	const approval = {
		id: "approval-1",
		callId: "call-1",
		command: "curl --version",
		runtime: "just-bash",
		reason: "Run bash command.",
		allowed: [],
		requestedBy: "42",
		details: [{ label: "Command", value: "curl --version", format: "code" as const }],
	};
	const pending = telegramApprovalText("ignored", approval);
	const approved = telegramApprovalText("ignored", approval, "approved", "user 42");

	assert.match(pending, /^\*Approval required\*/);
	assert.match(approved, /^\*Approved\*/);
	assert.match(approved, /Reason:\nRun bash command/);
	assert.match(approved, /Approved by user 42/);
});

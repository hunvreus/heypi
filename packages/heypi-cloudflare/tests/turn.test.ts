import assert from "node:assert/strict";
import { test } from "node:test";
import type { SessionEntry } from "@hunvreus/heypi/runtime";
import { runPiTurn } from "../src/turn.js";

// Exercises the container-side Pi turn under Node: rehydrate from entries, run, return entries.
// (Pi can't run in the Worker isolate; this is the code path that lives in the container.)

test("the Pi turn rehydrates from entries and accumulates across turns with no filesystem", async () => {
	const first = await runPiTurn({ sessionId: "s1", entries: [], text: "deploy staging" });
	assert.equal(first.reply, "ack: deploy staging");
	assert.equal(messageCount(first.entries), 2, "user + assistant after the first turn");

	const second = await runPiTurn({ sessionId: "s1", entries: first.entries, text: "status?" });
	assert.equal(messageCount(second.entries), 4, "prior transcript loaded back, second turn appended");
});

test("entries carry a linked parent chain (tree integrity survives the round-trip)", async () => {
	const { entries } = await runPiTurn({ sessionId: "s1", entries: [], text: "hello" });
	const ids = new Set(entries.map((entry) => entry.id));
	const parents = entries.map((entry) => entry.parentId).filter((id): id is string => id !== null);
	for (const parent of parents) assert.ok(ids.has(parent), "every parentId must reference a known entry");
});

function messageCount(entries: SessionEntry[]): number {
	return entries.filter((entry) => entry.type === "message").length;
}

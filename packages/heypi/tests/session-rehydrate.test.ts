import assert from "node:assert/strict";
import { test } from "node:test";
import type { Message } from "@earendil-works/pi-ai";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { captureSession, openSessionFromEntries } from "../src/runtime/session-rehydrate.js";

function userMessage(text: string): Message {
	return { role: "user", content: [{ type: "text", text }] } as Message;
}

function assistantMessage(text: string): Message {
	return { role: "assistant", content: [{ type: "text", text }] } as Message;
}

test("a session round-trips through capture and rehydrate with no filesystem", () => {
	const original = SessionManager.inMemory("/agent");
	assert.equal(original.isPersisted(), false, "in-memory sessions must not persist to disk");
	assert.equal(original.getSessionFile(), undefined, "in-memory sessions have no file");

	original.appendMessage(userMessage("deploy staging"));
	original.appendMessage(assistantMessage("on it"));
	original.appendMessage(userMessage("status?"));
	original.appendMessage(assistantMessage("healthy"));

	const snapshot = captureSession(original);
	const restored = openSessionFromEntries({ sessionId: snapshot.sessionId, cwd: "/agent", entries: snapshot.entries });

	// Identity and tree structure are preserved exactly (parent/child ids, ordering, leaf).
	assert.equal(restored.getSessionId(), original.getSessionId());
	assert.equal(restored.isPersisted(), false);
	assert.deepEqual(
		restored.getEntries().map((entry) => entry.id),
		original.getEntries().map((entry) => entry.id),
	);
	assert.equal(restored.getLeafId(), original.getLeafId(), "leaf pointer must survive rehydration");

	// The resolved LLM context (what actually matters for the next turn) is identical.
	const before = original.buildSessionContext();
	const after = restored.buildSessionContext();
	assert.equal(after.messages.length, before.messages.length);
	assert.deepEqual(after.messages, before.messages);
});

test("branching still works after rehydration (approval-resume depends on this)", () => {
	const original = SessionManager.inMemory("/agent");
	const firstId = original.appendMessage(userMessage("first"));
	original.appendMessage(assistantMessage("reply"));

	const restored = openSessionFromEntries({
		sessionId: original.getSessionId(),
		cwd: "/agent",
		entries: captureSession(original).entries,
	});

	// Branch back to the first entry and append a new child — the mechanism heypi's
	// approval-resume uses (session.branch(parentId); session.appendMessage(toolResult)).
	restored.branch(firstId);
	const branchedId = restored.appendMessage(assistantMessage("alternate reply"));

	assert.equal(restored.getEntry(branchedId)?.id, branchedId);
	const children = restored.getChildren(firstId).map((entry) => entry.id);
	assert.ok(children.includes(branchedId), "new branch child must attach to the rehydrated parent");
});

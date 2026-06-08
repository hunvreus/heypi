import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Message } from "@earendil-works/pi-ai";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { captureSession, openSessionFromEntries } from "../src/runtime/session-rehydrate.js";
import { sqliteStore } from "../src/store/sqlite.js";

function message(role: "user" | "assistant", text: string): Message {
	return { role, content: [{ type: "text", text }] } as Message;
}

async function withStore(fn: (store: ReturnType<typeof sqliteStore>) => Promise<void>): Promise<void> {
	const root = await mkdtemp(join(tmpdir(), "heypi-session-store-"));
	try {
		const store = sqliteStore({ path: join(root, "heypi.db") });
		await store.setup();
		await fn(store);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}

test("session store returns null for an unknown session", async () => {
	await withStore(async (store) => {
		assert.equal(await store.sessions?.load("does-not-exist"), null);
	});
});

test("session store round-trips an entry tree and upserts on save", async () => {
	await withStore(async (store) => {
		const sessions = store.sessions;
		assert.ok(sessions, "built-in sqlite store must expose a session store");

		const live = SessionManager.inMemory("/agent");
		live.appendMessage(message("user", "deploy staging"));
		live.appendMessage(message("assistant", "done"));
		const snapshot = captureSession(live);

		await sessions.save(snapshot.sessionId, snapshot.entries);
		const loaded = await sessions.load(snapshot.sessionId);
		assert.deepEqual(loaded, snapshot.entries);

		// Saving again replaces the snapshot (upsert), not append.
		live.appendMessage(message("user", "and rollback"));
		const next = captureSession(live);
		await sessions.save(next.sessionId, next.entries);
		const reloaded = await sessions.load(next.sessionId);
		assert.equal(reloaded?.length, next.entries.length);
		assert.deepEqual(reloaded, next.entries);
	});
});

test("a session survives a full store -> load -> rehydrate cycle (no shared filesystem)", async () => {
	await withStore(async (store) => {
		const sessions = store.sessions;
		assert.ok(sessions);

		// Turn 1: run in memory, persist the transcript blob.
		const first = SessionManager.inMemory("/agent");
		first.appendMessage(message("user", "what's the plan?"));
		first.appendMessage(message("assistant", "ship it"));
		const sessionId = first.getSessionId();
		await sessions.save(sessionId, captureSession(first).entries);

		// Turn 2: a fresh process loads the blob and rehydrates — no JSONL file involved.
		const entries = await sessions.load(sessionId);
		assert.ok(entries);
		const restored = openSessionFromEntries({ sessionId, cwd: "/agent", entries });

		restored.appendMessage(message("user", "go"));
		await sessions.save(sessionId, captureSession(restored).entries);

		// The accumulated context reflects both turns.
		const finalEntries = await sessions.load(sessionId);
		const rebuilt = openSessionFromEntries({ sessionId, cwd: "/agent", entries: finalEntries ?? [] });
		const messages = rebuilt.buildSessionContext().messages;
		assert.equal(messages.length, 3, "user + assistant from turn 1, plus user from turn 2");
	});
});

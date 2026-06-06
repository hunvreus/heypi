import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { CallRunner } from "../src/core/calls.js";
import { PiAgent } from "../src/runtime/pi-agent.js";
import { Queue } from "../src/runtime/queue.js";
import type { Runtime } from "../src/runtime/types.js";
import { sqliteStore } from "../src/store/sqlite.js";
import type { Sessions } from "../src/store/types.js";

/** Records how PiAgent drives the session store, and carries state across turns like a real store. */
class SpySessions implements Sessions {
	loads = 0;
	saves: number[] = [];
	loadReturns: (number | null)[] = [];
	private readonly blobs = new Map<string, SessionEntry[]>();

	async load(sessionId: string): Promise<SessionEntry[] | null> {
		this.loads++;
		const entries = this.blobs.get(sessionId) ?? null;
		this.loadReturns.push(entries ? entries.length : null);
		return entries;
	}

	async save(sessionId: string, entries: SessionEntry[]): Promise<void> {
		this.saves.push(entries.length);
		this.blobs.set(sessionId, entries);
	}
}

// This is the seam PR #1 introduced but could not fully exercise without driving a real PiAgent.
// We run real ask() turns (createAgentSession, resource loader, session.prompt all execute). With
// no API key the model call fails fast and synchronously, so the assertions never touch the
// network and stay deterministic — and they are written as relative comparisons, so they hold
// whether or not a provider key happens to be present in the environment.
test("PiAgent loads and saves the transcript through the SessionStore around each turn", async () => {
	const dir = await mkdtemp(join(tmpdir(), "heypi-piagent-store-"));
	const previousKey = process.env.ANTHROPIC_API_KEY;
	delete process.env.ANTHROPIC_API_KEY;
	try {
		const store = sqliteStore({ path: join(dir, "store.db") });
		await store.setup();
		const sessions = new SpySessions();
		const runtime: Runtime = { name: "just-bash", root: dir };
		const callRunner = new CallRunner(store.calls, store.approvals, new Queue({}), { name: "just-bash", root: dir });
		const agent = new PiAgent({
			agent: { id: "spike", model: { provider: "anthropic", name: "claude-3-5-haiku-20241022" }, directory: dir },
			callRunner,
			runtime,
			messages: store.messages,
			sessions,
		});
		const thread = await store.threads.getOrCreate({ agent: "spike", provider: "test", channel: "C1", key: "T1" });
		const base = {
			threadId: thread.id,
			sessionId: thread.sessionId,
			sessionPath: thread.sessionPath,
			provider: "test",
			channel: "C1",
			actor: "U1",
		};

		// The model call is expected to fail without a key; the load/save plumbing under test runs
		// in acquireSession (before) and a finally (after), so it happens regardless of the outcome.
		const runTurn = async (text: string) => {
			try {
				await agent.ask({ ...base, text });
			} catch {
				// expected without a provider key — irrelevant to the persistence behavior under test
			}
		};

		await runTurn("hello there");
		assert.equal(sessions.loads, 1, "the turn loads the session from the store before running");
		assert.equal(sessions.loadReturns[0], null, "nothing is stored before the first turn");
		assert.equal(sessions.saves.length, 1, "the turn saves the session after running");
		assert.ok(sessions.saves[0] >= 1, "the user prompt is captured and persisted even though the model call failed");

		await runTurn("and again");
		assert.equal(sessions.loads, 2);
		assert.equal(
			sessions.loadReturns[1],
			sessions.saves[0],
			"the second turn loads exactly what the first turn saved",
		);
		assert.ok(sessions.saves[1] > sessions.saves[0], "the second turn accumulates onto the loaded transcript");
	} finally {
		if (previousKey !== undefined) process.env.ANTHROPIC_API_KEY = previousKey;
		await rm(dir, { recursive: true, force: true });
	}
});

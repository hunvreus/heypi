import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createAgentRunner } from "../src/runtime/agent-runner.js";
import { sqliteStore } from "../src/store/sqlite.js";

// Hermetic: with no provider key the model call fails fast and synchronously, so this never hits
// the network. It proves createAgentRunner wires a real PiAgent turn (the failure surfaces from the
// model boundary, not from missing config). The real-reply path is exercised manually with a key.
test("createAgentRunner builds a real turn and surfaces the model auth boundary without a key", async () => {
	const dir = await mkdtemp(join(tmpdir(), "heypi-runner-"));
	const previousKey = process.env.ANTHROPIC_API_KEY;
	delete process.env.ANTHROPIC_API_KEY;
	try {
		const agentDir = join(dir, "agent");
		await mkdir(agentDir, { recursive: true });
		await writeFile(join(agentDir, "AGENTS.md"), "# test\nBe terse.\n");

		const store = sqliteStore({ path: join(dir, "store.db") });
		await store.setup();
		const runner = createAgentRunner({
			agent: {
				id: "runner",
				model: { provider: "anthropic", name: "claude-3-5-haiku-20241022" },
				directory: agentDir,
			},
			store,
		});

		await assert.rejects(
			() => runner.run({ sessionId: "s1", entries: [], text: "hello" }),
			/api key/i,
			"a turn with no provider key must reject from the model boundary",
		);
	} finally {
		if (previousKey !== undefined) process.env.ANTHROPIC_API_KEY = previousKey;
		await rm(dir, { recursive: true, force: true });
	}
});

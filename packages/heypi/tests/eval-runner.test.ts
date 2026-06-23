import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadAgent } from "../src/config.js";
import { runEvalAgent } from "../src/eval-runner.js";

const EVAL_MODEL = process.env.HEYPI_EVAL_MODEL?.trim();

test("runEvalAgent runs an eval through the full loaded agent", {
	skip: EVAL_MODEL ? false : "set HEYPI_EVAL_MODEL=provider/model to run model-backed eval integration",
}, async () => {
	assert.ok(EVAL_MODEL);
	const root = await mkdtemp(join(tmpdir(), "heypi-eval-agent-"));
	try {
		await mkdir(join(root, "agent", "tools"), { recursive: true });
		await writeFile(
			join(root, "agent", "instructions.md"),
			"Answer with only the requested token. For eval prompts, follow the user instruction exactly.",
			"utf8",
		);
		await writeFile(
			join(root, "agent", "tools", "marker.ts"),
			[
				`import { defineTool } from ${JSON.stringify(join(process.cwd(), "src/tool.ts"))};`,
				'export default defineTool({ name: "marker", description: "Marker tool.", input: {}, run: async () => "marker" });',
			].join("\n"),
			"utf8",
		);

		const agent = loadAgent(join(root, "agent"), { model: EVAL_MODEL });
		const result = await runEvalAgent({
			agent,
			evaluation: {
				name: "model-smoke",
				prompt: "Reply with exactly: HEYPI_EVAL_OK",
				timeoutMs: 60_000,
			},
		});

		assert.match(result.text, /HEYPI_EVAL_OK/);
		assert.ok(result.trace.startsWith("eval:"));
		assert.ok(result.threadId);
		const modelStarted = result.events.find((event) => event.type === "model.started");
		assert.ok(modelStarted);
		assert.match(JSON.stringify(modelStarted.data), /marker/);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

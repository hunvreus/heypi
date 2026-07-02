import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadAgent, stageAgent } from "../src/agent.js";

async function makeDir(name: string): Promise<string> {
	const root = join(tmpdir(), `heypi-${name}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	await mkdir(root, { recursive: true });
	return root;
}

describe("loadAgent", () => {
	it("loads file config and lets options override it", async () => {
		const root = await makeDir("load");
		await writeFile(join(root, "instructions.md"), "Use Pi.");
		await writeFile(join(root, "system.md"), "System note.");
		await writeFile(
			join(root, "config.json"),
			JSON.stringify({
				id: "file-id",
				context: { mode: "delta", maxMessages: 5 },
				approvals: { layout: "card" },
			}),
		);

		const agent = await loadAgent(root, {
			id: "option-id",
			context: { maxMessages: 2 },
			approvals: { showId: true },
		});

		expect(agent.id).toBe("option-id");
		expect(agent.instructions).toBe("Use Pi.");
		expect(agent.system).toBe("System note.");
		expect(agent.context).toEqual({ mode: "delta", maxMessages: 2 });
		expect(agent.approvals).toEqual({ layout: "card", showId: true });
	});

	it("reports malformed config files with their path", async () => {
		const root = await makeDir("bad-config");
		const config = join(root, "config.json");
		await writeFile(config, "{");

		await expect(loadAgent(root)).rejects.toThrow(`Failed to read ${config}`);
	});

	it("rejects invalid config enum values", async () => {
		const root = await makeDir("bad-enum");
		const config = join(root, "config.json");

		await writeFile(config, JSON.stringify({ context: { mode: "thread" } }));
		await expect(loadAgent(root)).rejects.toThrow("context.mode must be");

		await writeFile(config, JSON.stringify({ approvals: { layout: "panel" } }));
		await expect(loadAgent(root)).rejects.toThrow("approvals.layout must be");
	});
});

describe("stageAgent", () => {
	it("copies authored resources into a clean Pi-visible bundle", async () => {
		const root = await makeDir("stage");
		const state = await makeDir("state");
		await mkdir(join(root, "tools"), { recursive: true });
		await mkdir(join(root, "extensions"), { recursive: true });
		await mkdir(join(root, "skills"), { recursive: true });
		await mkdir(join(root, ".heypi", "sessions"), { recursive: true });
		await mkdir(join(root, "node_modules", "ignored"), { recursive: true });
		await writeFile(join(root, "instructions.md"), "Instruction");
		await writeFile(join(root, "system.md"), "System");
		await writeFile(join(root, "tools", "tool.ts"), "export {};");
		await writeFile(join(root, "extensions", "extension.ts"), "export {};");
		await writeFile(join(root, "skills", "skill.md"), "skill");
		await writeFile(join(root, ".heypi", "sessions", "state.jsonl"), "state");
		await writeFile(join(root, "node_modules", "ignored", "x.ts"), "ignored");

		const agent = await loadAgent(root, { id: "agent" });
		const first = await stageAgent(agent, state);
		await writeFile(join(first.agentDir, "stale.txt"), "stale");
		const second = await stageAgent(agent, state);

		await expect(readFile(join(second.agentDir, "instructions.md"), "utf8")).resolves.toBe("Instruction");
		await expect(readFile(join(second.agentDir, "APPEND_SYSTEM.md"), "utf8")).resolves.toBe("Instruction");
		await expect(readFile(join(second.agentDir, "SYSTEM.md"), "utf8")).resolves.toBe("System");
		await expect(readFile(join(second.agentDir, "skills", "skill.md"), "utf8")).resolves.toBe("skill");
		await expect(readFile(join(second.agentDir, "extensions", "extension.ts"), "utf8")).resolves.toBe("export {};");
		await expect(readFile(join(second.agentDir, "stale.txt"), "utf8")).rejects.toThrow();
		await expect(readFile(join(second.agentDir, ".heypi", "sessions", "state.jsonl"), "utf8")).rejects.toThrow();
		await expect(readFile(join(second.agentDir, "node_modules", "ignored", "x.ts"), "utf8")).rejects.toThrow();
		expect(second.extensionPaths).toEqual([join(second.agentDir, "tools", "tool.ts")]);
	});
});

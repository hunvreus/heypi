import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadAgent, stageAgent } from "../src/agent.js";
import { docker, host } from "../src/runtime.js";

async function makeDir(name: string): Promise<string> {
	const root = join(tmpdir(), `heypi-${name}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	await mkdir(root, { recursive: true });
	return root;
}

describe("loadAgent", () => {
	it("loads authored files and code config", async () => {
		const root = await makeDir("load");
		await writeFile(join(root, "instructions.md"), "Use Pi.");
		await writeFile(join(root, "system.md"), "System note.");

		const agent = await loadAgent(root, {
			id: "agent-id",
			runtime: host({ workspace: "/tmp/option-workspace", env: { NODE_ENV: "test" } }),
			admin: { port: 4322 },
			tools: { edit: false },
		});

		expect(agent.id).toBe("agent-id");
		expect(agent.instructions).toBe("Use Pi.");
		expect(agent.system).toBe("System note.");
		expect(agent.runtime).toEqual({ kind: "host", workspace: "/tmp/option-workspace", env: { NODE_ENV: "test" } });
		expect(agent.admin).toEqual({ port: 4322 });
		expect(agent.tools).toEqual({ edit: false });
	});

	it("declares core runtime providers without exposing secret semantics", () => {
		expect(docker({ workspace: "/workspace", image: "node:22", env: { CI: "1" } })).toEqual({
			kind: "docker",
			workspace: "/workspace",
			image: "node:22",
			env: { CI: "1" },
		});
	});
});

describe("stageAgent", () => {
	it("copies authored resources into a clean Pi-visible bundle", async () => {
		const root = await makeDir("stage");
		const state = await makeDir("state");
		await mkdir(join(root, "tools"), { recursive: true });
		await mkdir(join(root, "extensions"), { recursive: true });
		await mkdir(join(root, "skills"), { recursive: true });
		await mkdir(join(root, "schedules"), { recursive: true });
		await mkdir(join(root, ".heypi", "sessions"), { recursive: true });
		await mkdir(join(root, "node_modules", "ignored"), { recursive: true });
		await writeFile(join(root, "instructions.md"), "Instruction");
		await writeFile(join(root, "system.md"), "System");
		await writeFile(join(root, "tools", "tool.ts"), "export {};");
		await writeFile(join(root, "extensions", "extension.ts"), "export {};");
		await writeFile(join(root, "skills", "skill.md"), "skill");
		await writeFile(join(root, "schedules", "daily.ts"), "export default {};");
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
		await expect(readFile(join(second.agentDir, "schedules", "daily.ts"), "utf8")).rejects.toThrow();
		await expect(readFile(join(second.agentDir, "stale.txt"), "utf8")).rejects.toThrow();
		await expect(readFile(join(second.agentDir, ".heypi", "sessions", "state.jsonl"), "utf8")).rejects.toThrow();
		await expect(readFile(join(second.agentDir, "node_modules", "ignored", "x.ts"), "utf8")).rejects.toThrow();
		expect(second.extensionPaths).toEqual([join(second.agentDir, "tools", "tool.ts")]);
		expect(second.skillsDir).toBe(join(second.agentDir, "skills"));
	});
});

import { existsSync } from "node:fs";
import { cp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { basename, join, relative, resolve, sep } from "node:path";
import type { AgentConfig, LoadAgentOptions } from "./types.js";

async function readOptional(path: string): Promise<string | undefined> {
	if (!existsSync(path)) return undefined;
	return readFile(path, "utf8");
}

async function listFiles(root: string): Promise<string[]> {
	if (!existsSync(root)) return [];
	const entries = await readdir(root, { recursive: true, withFileTypes: true });
	return entries
		.filter((entry) => entry.isFile())
		.map((entry) => resolve(entry.parentPath ?? root, entry.name))
		.sort((a, b) => a.localeCompare(b));
}

export async function loadAgent(dir: string, options: LoadAgentOptions = {}): Promise<AgentConfig> {
	const root = resolve(dir);
	return {
		...options,
		id: options.id ?? (basename(root) || "agent"),
		root,
		instructions: await readOptional(join(root, "instructions.md")),
		system: await readOptional(join(root, "system.md")),
	};
}

export type StagedAgent = {
	root: string;
	agentDir: string;
	extensionPaths: string[];
	skillsDir?: string;
};

export async function stageAgent(agent: AgentConfig, stateDir: string): Promise<StagedAgent> {
	const root = join(stateDir, "agents", agent.id);
	const agentDir = join(root, "agent");
	await mkdir(root, { recursive: true });
	await rm(agentDir, { recursive: true, force: true });
	await cp(agent.root, agentDir, {
		recursive: true,
		force: true,
		filter: (source) => {
			const parts = relative(agent.root, source).split(sep);
			return (
				!parts.includes(".git") &&
				!parts.includes(".heypi") &&
				!parts.includes("node_modules") &&
				parts[0] !== "schedules"
			);
		},
	});
	if (agent.system) await writeFile(join(agentDir, "SYSTEM.md"), agent.system);
	if (agent.instructions) await writeFile(join(agentDir, "APPEND_SYSTEM.md"), agent.instructions);
	// Pi discovers staged `extensions/` and `skills/` from agentDir. `tools/`
	// is an authoring alias for extension files that register callable tools.
	const extensionPaths = (await listFiles(join(agentDir, "tools"))).filter(
		(path) => path.endsWith(".ts") || path.endsWith(".js"),
	);
	const skillsDir = join(agentDir, "skills");
	return { root, agentDir, extensionPaths, skillsDir: existsSync(skillsDir) ? skillsDir : undefined };
}

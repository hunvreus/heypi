import { existsSync } from "node:fs";
import { cp, mkdir, readdir, readFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import type { AgentConfig, AgentFileConfig, AgentResource, LoadAgentOptions } from "./types.js";

const DISCOVERED_DIRS = ["skills", "tools", "extensions"] as const;

async function readOptional(path: string): Promise<string | undefined> {
	if (!existsSync(path)) return undefined;
	return readFile(path, "utf8");
}

async function readConfig(path: string): Promise<AgentFileConfig | undefined> {
	const text = await readOptional(path);
	if (!text) return undefined;
	return JSON.parse(text) as AgentFileConfig;
}

async function listFiles(root: string, kind: AgentResource["kind"]): Promise<AgentResource[]> {
	if (!existsSync(root)) return [];
	const entries = await readdir(root, { recursive: true, withFileTypes: true });
	return entries
		.filter((entry) => entry.isFile())
		.map((entry) => {
			const parent = entry.parentPath ?? root;
			const path = resolve(parent, entry.name);
			return { path, name: basename(path), kind };
		})
		.sort((a, b) => a.path.localeCompare(b.path));
}

/** Loads an agent folder and discovers authored resources without starting Pi. */
export async function loadAgent(dir: string, options: LoadAgentOptions = {}): Promise<AgentConfig> {
	const root = resolve(dir);
	const instructionsPath = join(root, "instructions.md");
	const systemPath = join(root, "system.md");
	const configPath = join(root, "config.json");
	const resources: AgentResource[] = [];
	const instructions = await readOptional(instructionsPath);
	const system = await readOptional(systemPath);
	const fileConfig = (await readConfig(configPath)) ?? {};
	if (instructions) resources.push({ path: instructionsPath, name: "instructions.md", kind: "instruction" });
	if (system) resources.push({ path: systemPath, name: "system.md", kind: "system" });
	if (existsSync(configPath)) resources.push({ path: configPath, name: "config.json", kind: "config" });
	for (const dirName of DISCOVERED_DIRS) {
		const kind = dirName.slice(0, -1) as "skill" | "tool" | "extension";
		resources.push(...(await listFiles(join(root, dirName), kind)));
	}
	return {
		...fileConfig,
		...options,
		id: options.id ?? fileConfig.id ?? (basename(root) || "agent"),
		root,
		instructions,
		system,
		resources,
	};
}

export type StagedAgent = {
	root: string;
	agentDir: string;
	workspaceDir: string;
	toolPaths: string[];
};

/**
 * Stages agent-authored files into a Pi-visible bundle.
 *
 * The source tree is copied, not mounted. Pi can read the staged bundle, while
 * heypi avoids leaking host source paths into the model prompt.
 */
export async function stageAgent(agent: AgentConfig, stateDir: string): Promise<StagedAgent> {
	const root = join(stateDir, "agents", agent.id);
	const agentDir = join(root, "agent");
	const workspaceDir = join(root, "workspace");
	await mkdir(root, { recursive: true });
	await mkdir(workspaceDir, { recursive: true });
	await cp(agent.root, agentDir, {
		recursive: true,
		force: true,
		filter: (source) => !source.includes(`${agent.root}/node_modules`) && !source.includes(`${agent.root}/.git`),
	});
	const toolPaths = (await listFiles(join(agentDir, "tools"), "tool"))
		.map((tool) => tool.path)
		.filter((path) => path.endsWith(".ts") || path.endsWith(".js"));
	return { root, agentDir, workspaceDir, toolPaths };
}

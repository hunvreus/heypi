import { existsSync } from "node:fs";
import { cp, mkdir, readdir, readFile, rm } from "node:fs/promises";
import { basename, join, relative, resolve, sep } from "node:path";
import type { AgentConfig, AgentFileConfig, LoadAgentOptions } from "./types.js";

async function readOptional(path: string): Promise<string | undefined> {
	if (!existsSync(path)) return undefined;
	return readFile(path, "utf8");
}

async function readConfig(path: string): Promise<AgentFileConfig | undefined> {
	const text = await readOptional(path);
	if (!text) return undefined;
	return JSON.parse(text) as AgentFileConfig;
}

async function listFiles(root: string): Promise<string[]> {
	if (!existsSync(root)) return [];
	const entries = await readdir(root, { recursive: true, withFileTypes: true });
	return entries
		.filter((entry) => entry.isFile())
		.map((entry) => {
			const parent = entry.parentPath ?? root;
			return resolve(parent, entry.name);
		})
		.sort((a, b) => a.localeCompare(b));
}

/** Loads an agent folder and discovers authored resources without starting Pi. */
export async function loadAgent(dir: string, options: LoadAgentOptions = {}): Promise<AgentConfig> {
	const root = resolve(dir);
	const instructionsPath = join(root, "instructions.md");
	const systemPath = join(root, "system.md");
	const configPath = join(root, "config.json");
	const instructions = await readOptional(instructionsPath);
	const system = await readOptional(systemPath);
	const fileConfig = (await readConfig(configPath)) ?? {};
	return {
		...fileConfig,
		...options,
		id: options.id ?? fileConfig.id ?? (basename(root) || "agent"),
		root,
		instructions,
		system,
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
	await rm(agentDir, { recursive: true, force: true });
	await mkdir(workspaceDir, { recursive: true });
	await cp(agent.root, agentDir, {
		recursive: true,
		force: true,
		filter: (source) => {
			const parts = relative(agent.root, source).split(sep);
			return !parts.includes("node_modules") && !parts.includes(".git");
		},
	});
	const toolPaths = (await listFiles(join(agentDir, "tools"))).filter(
		(path) => path.endsWith(".ts") || path.endsWith(".js"),
	);
	return { root, agentDir, workspaceDir, toolPaths };
}

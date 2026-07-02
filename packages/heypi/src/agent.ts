import { existsSync } from "node:fs";
import { cp, mkdir, readdir, readFile, rm } from "node:fs/promises";
import { basename, join, relative, resolve, sep } from "node:path";
import type { AgentConfig, AgentFileConfig, LoadAgentOptions } from "./types.js";

async function readOptional(path: string): Promise<string | undefined> {
	if (!existsSync(path)) return undefined;
	return readFile(path, "utf8");
}

async function readJsonConfig(path: string): Promise<AgentFileConfig> {
	const text = await readOptional(path);
	if (!text) return {};
	return JSON.parse(text) as AgentFileConfig;
}

async function listFiles(root: string): Promise<string[]> {
	if (!existsSync(root)) return [];
	const entries = await readdir(root, { recursive: true, withFileTypes: true });
	return entries
		.filter((entry) => entry.isFile())
		.map((entry) => resolve(entry.parentPath ?? root, entry.name))
		.sort((a, b) => a.localeCompare(b));
}

function mergeAgentConfig(fileConfig: AgentFileConfig, options: LoadAgentOptions): LoadAgentOptions {
	return {
		...fileConfig,
		...options,
		context: { ...fileConfig.context, ...options.context },
		approvals: { ...fileConfig.approvals, ...options.approvals },
		state: { ...fileConfig.state, ...options.state },
	};
}

export async function loadAgent(dir: string, options: LoadAgentOptions = {}): Promise<AgentConfig> {
	const root = resolve(dir);
	const fileConfig = await readJsonConfig(join(root, "config.json"));
	const merged = mergeAgentConfig(fileConfig, options);
	return {
		...merged,
		id: merged.id ?? (basename(root) || "agent"),
		root,
		instructions: await readOptional(join(root, "instructions.md")),
		system: await readOptional(join(root, "system.md")),
	};
}

export type StagedAgent = {
	root: string;
	agentDir: string;
	workspaceDir: string;
	toolPaths: string[];
};

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
			return !parts.includes(".git") && !parts.includes("node_modules");
		},
	});
	const toolPaths = (await listFiles(join(agentDir, "tools"))).filter(
		(path) => path.endsWith(".ts") || path.endsWith(".js"),
	);
	return { root, agentDir, workspaceDir, toolPaths };
}

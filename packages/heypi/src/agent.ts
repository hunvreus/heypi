import { existsSync } from "node:fs";
import { cp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { basename, join, relative, resolve, sep } from "node:path";
import type { AgentConfig, AgentFileConfig, LoadAgentOptions } from "./types.js";

async function readOptional(path: string): Promise<string | undefined> {
	if (!existsSync(path)) return undefined;
	return readFile(path, "utf8");
}

async function readJsonConfig(path: string): Promise<AgentFileConfig> {
	const text = await readOptional(path);
	if (!text) return {};
	try {
		return validateConfig(JSON.parse(text), path);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`Failed to read ${path}: ${message}`);
	}
}

function validateConfig(value: unknown, path: string): AgentFileConfig {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error("expected an object");
	}
	const config = value as AgentFileConfig;
	if (config.context?.mode && config.context.mode !== "current" && config.context.mode !== "delta") {
		throw new Error(`context.mode must be "current" or "delta" in ${path}`);
	}
	if (config.approvals?.layout && config.approvals.layout !== "message" && config.approvals.layout !== "card") {
		throw new Error(`approvals.layout must be "message" or "card" in ${path}`);
	}
	return config;
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
	extensionPaths: string[];
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
			return !parts.includes(".git") && !parts.includes(".heypi") && !parts.includes("node_modules");
		},
	});
	if (agent.system) await writeFile(join(agentDir, "SYSTEM.md"), agent.system);
	if (agent.instructions) await writeFile(join(agentDir, "APPEND_SYSTEM.md"), agent.instructions);
	// Pi discovers staged `extensions/` and `skills/` from agentDir. `tools/`
	// is an authoring alias for extension files that register callable tools.
	const extensionPaths = (await listFiles(join(agentDir, "tools"))).filter(
		(path) => path.endsWith(".ts") || path.endsWith(".js"),
	);
	return { root, agentDir, workspaceDir, extensionPaths };
}

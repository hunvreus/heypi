import { existsSync, readdirSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, extname, relative, resolve } from "node:path";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { EvalConfig } from "./eval.js";
import type { JobConfig } from "./job.js";
import { assignDiscoveredToolName } from "./tool.js";

const require = createRequire(import.meta.url);
const MODULE_EXTENSIONS = new Set([".js", ".mjs", ".cjs", ".ts", ".mts", ".cts"]);

type LoadedModule = Record<string, unknown> & { default?: unknown };

/** Loads default-exported tools from a folder. File stems become tool names when omitted. */
export function loadTools(folder: string): ToolDefinition[] {
	const tools: ToolDefinition[] = [];
	const seen = new Map<string, string>();
	for (const file of moduleFiles(folder)) {
		const name = basename(file, extname(file));
		for (const tool of valuesFromModule<ToolDefinition>(file, "tool")) {
			const loaded = assignDiscoveredToolName(tool, name);
			if (seen.has(loaded.name)) {
				throw new Error(`duplicate tool name "${loaded.name}" in ${seen.get(loaded.name)} and ${file}`);
			}
			seen.set(loaded.name, file);
			tools.push(loaded);
		}
	}
	return tools;
}

/** Loads default-exported jobs from a folder. */
export function loadJobs(folder: string): JobConfig[] {
	const jobs: JobConfig[] = [];
	const seen = new Map<string, string>();
	for (const file of moduleFiles(folder)) {
		for (const job of valuesFromModule<JobConfig>(file, "job")) {
			if (!job.id) throw new Error(`job in ${file} is missing id`);
			if (seen.has(job.id)) throw new Error(`duplicate job id "${job.id}" in ${seen.get(job.id)} and ${file}`);
			seen.set(job.id, file);
			jobs.push(job);
		}
	}
	return jobs;
}

/** Loads default-exported evals from a folder. */
export function loadEvals(folder: string): EvalConfig[] {
	const evals: EvalConfig[] = [];
	const seen = new Map<string, string>();
	for (const file of moduleFiles(folder)) {
		for (const evaluation of valuesFromModule<EvalConfig>(file, "eval")) {
			if (!evaluation.name) throw new Error(`eval in ${file} is missing name`);
			if (seen.has(evaluation.name)) {
				throw new Error(`duplicate eval name "${evaluation.name}" in ${seen.get(evaluation.name)} and ${file}`);
			}
			seen.set(evaluation.name, file);
			evals.push(evaluation);
		}
	}
	return evals;
}

function moduleFiles(folder: string): string[] {
	const root = resolve(folder);
	if (!existsSync(root)) return [];
	if (!statSync(root).isDirectory()) throw new Error(`load folder is not a directory: ${root}`);
	return collectModuleFiles(root)
		.filter((path) => MODULE_EXTENSIONS.has(extname(path)) && !path.endsWith(".d.ts"))
		.sort((a, b) => relative(root, a).localeCompare(relative(root, b)));
}

function collectModuleFiles(root: string): string[] {
	const files: string[] = [];
	for (const entry of readdirSync(root)) {
		const path = resolve(root, entry);
		const stat = statSync(path);
		if (stat.isDirectory()) files.push(...collectModuleFiles(path));
		else if (stat.isFile()) files.push(path);
	}
	return files;
}

function valuesFromModule<T>(file: string, kind: string): T[] {
	const mod = require(file) as LoadedModule;
	const value = mod.default;
	if (value === undefined) throw new Error(`${kind} module ${file} must default-export a ${kind} or ${kind} array`);
	const values = Array.isArray(value) ? value : [value];
	if (values.some((item) => !item || typeof item !== "object")) {
		throw new Error(`${kind} module ${file} must default-export a ${kind} object or ${kind} array`);
	}
	return values as T[];
}

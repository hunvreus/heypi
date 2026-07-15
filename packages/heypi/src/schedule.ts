import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { dirname, extname, relative, resolve, sep } from "node:path";
import { Cron } from "croner";
import { createJiti } from "jiti";

export type ScheduleTarget = {
	adapterId: string;
	conversation: string;
	thread?: string;
};

export type ScheduleDispatch = {
	prompt: string;
	target: ScheduleTarget;
};

export type ScheduleContext = {
	scheduleId: string;
	runId: string;
	scheduledFor: string;
	firedAt: string;
	signal: AbortSignal;
	dispatch(input: ScheduleDispatch): Promise<{ jobId: string }>;
};

type ScheduleBase = {
	cron: string;
	timezone: string;
	dependencies?: string[];
};

export type ScheduleDefinition = ScheduleBase &
	({ prompt: string; run?: never } | { prompt?: never; run(context: ScheduleContext): Promise<void> | void });

export type LoadedSchedule = {
	id: string;
	path: string;
	hash: string;
	definition: ScheduleDefinition;
};

/** Provides type checking for a code-owned cron schedule. */
export function defineSchedule(definition: ScheduleDefinition): ScheduleDefinition {
	return definition;
}

function scheduleId(root: string, path: string): string {
	const extension = extname(path);
	return relative(root, path).slice(0, -extension.length).split(sep).join("/");
}

function validateTimezone(timezone: string, id: string): void {
	try {
		new Intl.DateTimeFormat("en", { timeZone: timezone }).format();
	} catch {
		throw new Error(`Invalid timezone for schedule ${id}: ${timezone}`);
	}
}

export function validateSchedule(id: string, definition: ScheduleDefinition): void {
	if (!definition || typeof definition !== "object") throw new Error(`Schedule ${id} must export a definition.`);
	if (definition.cron.trim().split(/\s+/).length !== 5) {
		throw new Error(`Schedule ${id} must use a five-field cron expression.`);
	}
	validateTimezone(definition.timezone, id);
	const parser = new Cron(definition.cron, { timezone: definition.timezone, mode: "5-part", paused: true });
	parser.stop();
	const hasPrompt = typeof definition.prompt === "string" && definition.prompt.trim().length > 0;
	const hasRun = typeof definition.run === "function";
	if (hasPrompt === hasRun) throw new Error(`Schedule ${id} must define exactly one of prompt or run.`);
	if (definition.dependencies?.some((dependency) => !dependency.trim())) {
		throw new Error(`Schedule ${id} dependencies must be non-empty paths.`);
	}
}

async function scheduleHash(path: string, source: Buffer, definition: ScheduleDefinition): Promise<string> {
	const hash = createHash("sha256");
	hash.update(source);
	hash.update(
		JSON.stringify({
			cron: definition.cron,
			timezone: definition.timezone,
			prompt: definition.prompt,
			run: definition.run?.toString(),
		}),
	);
	for (const dependency of [...(definition.dependencies ?? [])].sort()) {
		const dependencyPath = resolve(dirname(path), dependency);
		hash.update(dependency);
		hash.update(await readFile(dependencyPath));
	}
	return hash.digest("hex");
}

/** Loads authored schedule modules without copying them into Pi's resource bundle. */
export async function loadSchedules(agentRoot: string): Promise<LoadedSchedule[]> {
	const root = resolve(agentRoot, "schedules");
	if (!existsSync(root)) return [];
	const jiti = createJiti(import.meta.url, { moduleCache: false, fsCache: false });
	const entries = await readdir(root, { recursive: true, withFileTypes: true });
	const paths = entries
		.filter((entry) => entry.isFile() && /\.(?:[cm]?[jt]s)$/.test(entry.name) && !entry.name.endsWith(".d.ts"))
		.map((entry) => resolve(entry.parentPath ?? root, entry.name))
		.sort((left, right) => left.localeCompare(right));
	const schedules: LoadedSchedule[] = [];
	const ids = new Map<string, string>();
	for (const path of paths) {
		const id = scheduleId(root, path);
		const duplicate = ids.get(id);
		if (duplicate) throw new Error(`Duplicate schedule id ${id}: ${duplicate} and ${path}`);
		ids.set(id, path);
		const source = await readFile(path);
		const imported = await jiti.import<{ default?: ScheduleDefinition }>(path);
		if (!imported.default) throw new Error(`Schedule ${id} must have a default export.`);
		validateSchedule(id, imported.default);
		schedules.push({
			id,
			path,
			hash: await scheduleHash(path, source, imported.default),
			definition: imported.default,
		});
	}
	return schedules;
}

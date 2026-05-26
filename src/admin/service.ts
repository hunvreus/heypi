import { createHash } from "node:crypto";
import type { AdapterStart } from "../io/handler.js";
import type { JobScope, JobTargets } from "../job.js";
import type { Approval, Call, Job, JobRun, Turn } from "../store/types.js";

export type AdminPageInput = {
	limit?: number;
	offset?: number;
};

export type AdminPage<T> = {
	rows: T[];
	limit: number;
	offset: number;
	hasNext: boolean;
};

export type AdminService = {
	overview(): Promise<AdminOverview>;
	live(): Promise<AdminLiveSummary>;
	approvals(input?: AdminPageInput): Promise<AdminPage<Approval>>;
	jobs(input?: AdminPageInput): Promise<AdminPage<AdminJob>>;
	activity(input?: AdminPageInput): Promise<AdminPage<AdminActivityRow>>;
	memory(input?: AdminPageInput): Promise<AdminMemory>;
};

export type AdminOverview = {
	agent: { id: string; directory?: string; model?: string };
	runtime: { name: string; root: string };
	startedAt: number;
	adapters: Array<{ name: string; kind: string }>;
	memory: AdminMemory;
	threads: number;
	live: AdminLiveSummary;
};

export type AdminLiveSummary = {
	pendingApprovals: number;
	runningRuns: number;
	jobs: number;
	activeJobs: number;
	pausedJobs: number;
	recentCalls: number;
	checkedAt: number;
	revision: string;
};

export type AdminJob = Job & { route?: string; lastRun?: JobRun | null };

export type AdminActivityRow = {
	id: string;
	kind: "approval" | "call" | "job" | "run";
	title: string;
	summary: string;
	state: string;
	channel?: string;
	actor?: string;
	time: number;
	durationMs?: number;
	href?: string;
};

export type AdminMemory = {
	enabled: boolean;
	scope: string;
	writePolicy: string;
	maxChars: number;
	total: number;
	limit: number;
	offset: number;
	hasNext: boolean;
	entries: Array<{
		scopePath: string;
		path: string;
		size: number;
		mtimeMs: number;
		sha256: string;
		text: string;
		truncated: boolean;
	}>;
};

const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 50;

export function createAdminService(start: AdapterStart): AdminService {
	const app = required(start.app, "admin requires app context");
	const store = required(start.store, "admin requires store context");

	const service: AdminService = {
		async overview(): Promise<AdminOverview> {
			const [threads, live, memory] = await Promise.all([
				store.threads.list({ agent: app.agent, limit: 1000 }),
				service.live(),
				service.memory(),
			]);
			return {
				agent: {
					id: app.agent,
					directory: app.agentDirectory,
					model: app.agentModel ? `${app.agentModel.provider}/${app.agentModel.name}` : undefined,
				},
				runtime: app.runtime,
				startedAt: app.startedAt,
				adapters: app.adapters,
				memory,
				threads: threads.length,
				live,
			};
		},
		async live(): Promise<AdminLiveSummary> {
			const [approvals, jobs, runningRuns, calls] = await Promise.all([
				store.approvals.listPending({ limit: 100 }),
				store.jobs?.list({ agent: app.agent, limit: 1000 }) ?? [],
				store.turns.listRunning?.({ agent: app.agent, limit: 100 }) ?? [],
				store.calls.listRecent?.({ limit: 100 }) ?? [],
			]);
			const checkedAt = Date.now();
			const revision = revisionHash([
				...approvals.map((row) => ["approval", row.id, row.state, row.requestedAt, row.resolvedAt]),
				...jobs.map((row) => ["job", row.id, row.state, row.nextAt, row.lastAt, row.updatedAt]),
				...runningRuns.map((row) => ["run", row.id, row.state, row.updatedAt]),
				...calls.map((row) => ["call", row.id, row.state, row.updatedAt]),
			]);
			return {
				pendingApprovals: approvals.length,
				runningRuns: runningRuns.length,
				jobs: jobs.length,
				activeJobs: jobs.filter((row) => row.state === "active").length,
				pausedJobs: jobs.filter((row) => row.state === "paused").length,
				recentCalls: calls.length,
				checkedAt,
				revision,
			};
		},
		async approvals(input: AdminPageInput = {}): Promise<AdminPage<Approval>> {
			const page = pageInput(input);
			const rows = await store.approvals.listPending({ limit: page.limit + 1, offset: page.offset });
			return toPage(rows, page);
		},
		async jobs(input: AdminPageInput = {}): Promise<AdminPage<AdminJob>> {
			const page = pageInput(input);
			const rows = await (store.jobs?.list({ agent: app.agent, limit: page.limit + 1, offset: page.offset }) ?? []);
			const withRuns = await Promise.all(
				rows.map(async (job) => ({
					...job,
					route: jobRoute(job),
					lastRun: (await store.jobRuns?.lastForJob({ agent: job.agent, id: job.id })) ?? null,
				})),
			);
			return toPage(withRuns, page);
		},
		async activity(input: AdminPageInput = {}): Promise<AdminPage<AdminActivityRow>> {
			const page = pageInput(input);
			const fetchLimit = page.offset + page.limit + 1;
			const [approvals, jobs, runs, calls] = await Promise.all([
				store.approvals.listPending({ limit: fetchLimit }),
				store.jobs?.list({ agent: app.agent, limit: fetchLimit }) ?? [],
				store.turns.listRecent?.({ agent: app.agent, limit: fetchLimit }) ?? [],
				store.calls.listRecent?.({ limit: fetchLimit }) ?? [],
			]);
			const rows = [
				...approvals.map(approvalActivity),
				...jobs.map(jobActivity),
				...runs.map(runActivity),
				...calls.map(callActivity),
			].sort((left, right) => right.time - left.time || left.kind.localeCompare(right.kind));
			return toPage(rows.slice(page.offset), page);
		},
		async memory(input: AdminPageInput = {}): Promise<AdminMemory> {
			const page = pageInput(input);
			const settings = start.memory?.settings() ?? app.memory;
			const rows = await (start.memory?.list({ limit: page.limit + 1, offset: page.offset }) ?? Promise.resolve([]));
			return {
				enabled: settings.enabled,
				scope: settings.scope,
				writePolicy: settings.writePolicy,
				maxChars: settings.maxChars,
				total: await (start.memory?.count() ?? Promise.resolve(0)),
				limit: page.limit,
				offset: page.offset,
				hasNext: rows.length > page.limit,
				entries: rows.slice(0, page.limit),
			};
		},
	};

	return service;
}

function approvalActivity(row: Approval): AdminActivityRow {
	return {
		id: row.id,
		kind: "approval",
		title: row.command,
		summary: row.reason,
		state: row.state,
		channel: row.channel,
		actor: row.requestedBy ?? undefined,
		time: row.requestedAt,
		href: "/admin/approvals",
	};
}

function jobActivity(row: Job): AdminActivityRow {
	return {
		id: row.id,
		kind: "job",
		title: row.id,
		summary: row.prompt,
		state: row.state,
		channel: jobRoute(row),
		time: row.nextAt ?? row.updatedAt,
		href: "/admin/jobs",
	};
}

function jobRoute(row: Pick<Job, "scope" | "target">): string | undefined {
	const targets = parseJson<JobTargets>(row.target);
	if (targets) return routeText(targets, "targets");
	const scope = parseJson<JobScope>(row.scope);
	if (scope) return routeText(scope, "scope");
	return row.target ?? row.scope ?? undefined;
}

function routeText(input: JobTargets | JobScope, kind: "targets" | "scope"): string {
	const entries = Object.entries(input) as Array<
		[string, { teams?: string[]; channels?: string[]; users?: string[] }]
	>;
	const rows = entries.flatMap(([adapter, route]) => {
		const parts = [ids("team", route.teams), ids("channel", route.channels), ids("user", route.users)].filter(
			Boolean,
		);
		return parts.length ? parts.map((part) => `${adapter} ${part}`) : [`${adapter} all known threads`];
	});
	return rows.length ? `${kind}: ${rows.join(", ")}` : `${kind}: none`;
}

function ids(label: string, values?: string[]): string | undefined {
	if (!values?.length) return undefined;
	return `${label}${values.length === 1 ? "" : "s"} ${values.join(", ")}`;
}

function parseJson<T>(input: string | null): T | undefined {
	if (!input) return undefined;
	try {
		return JSON.parse(input) as T;
	} catch {
		return undefined;
	}
}

function runActivity(row: Turn): AdminActivityRow {
	return {
		id: row.id,
		kind: "run",
		title: row.trace ?? row.id,
		summary: `${row.provider}/${row.kind}`,
		state: row.state,
		channel: row.channel,
		actor: row.actor ?? undefined,
		time: row.updatedAt,
	};
}

function callActivity(row: Call): AdminActivityRow {
	return {
		id: row.id,
		kind: "call",
		title: row.tool,
		summary: row.command ?? row.args ?? "",
		state: row.state,
		channel: row.channel,
		actor: row.actor ?? undefined,
		time: row.updatedAt,
		durationMs: row.ms ?? undefined,
	};
}

function pageInput(input: AdminPageInput): Pick<AdminPage<never>, "limit" | "offset"> {
	const rawLimit = input.limit ?? DEFAULT_LIMIT;
	const rawOffset = input.offset ?? 0;
	const limit = Math.min(Math.max(Math.trunc(rawLimit), 1), MAX_LIMIT);
	const offset = Math.max(Math.trunc(rawOffset), 0);
	return { limit, offset };
}

function toPage<T>(rows: T[], page: Pick<AdminPage<T>, "limit" | "offset">): AdminPage<T> {
	return {
		rows: rows.slice(0, page.limit),
		limit: page.limit,
		offset: page.offset,
		hasNext: rows.length > page.limit,
	};
}

function revisionHash(input: unknown): string {
	return createHash("sha256").update(JSON.stringify(input)).digest("hex").slice(0, 16);
}

function required<T>(input: T | undefined, message: string): T {
	if (input === undefined) throw new Error(message);
	return input;
}

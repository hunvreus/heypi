import { createHash, randomUUID } from "node:crypto";
import type { ApprovalConfig, PermissionsConfig, TaskConfig } from "../config.js";
import type { EvalConfig, EvalExpect } from "../eval.js";
import type { AdapterStart } from "../io/handler.js";
import type { JobScope, JobTargets } from "../job.js";
import { clampLimit, clampOffset } from "../store/paging.js";
import type {
	Approval,
	ApprovalBypass,
	Call,
	Event,
	Job,
	JobRun,
	Message,
	MessageWithThread,
	Thread,
	Turn,
} from "../store/types.js";

type AdminPageInput = {
	limit?: number;
	offset?: number;
	q?: string;
	provider?: string;
	type?: string;
	state?: string;
	channel?: string;
	actor?: string;
	scope?: string;
};

export type AdminPageFilters = Pick<
	AdminPageInput,
	"q" | "provider" | "type" | "state" | "channel" | "actor" | "scope"
>;

export type AdminFilterFacets = {
	providers: string[];
	channels: string[];
	actors: string[];
	scopes: string[];
};

export type AdminPage<T> = {
	rows: T[];
	limit: number;
	offset: number;
	hasNext: boolean;
	truncated?: boolean;
	filters?: AdminPageFilters;
	facets?: AdminFilterFacets;
};

export type AdminService = {
	overview(): Promise<AdminOverview>;
	live(): Promise<AdminLiveSummary>;
	sendMessage(input: AdminSendMessageInput): Promise<AdminSendMessageResult>;
	resolveApproval(input: AdminResolveApprovalInput): Promise<AdminResolveApprovalResult>;
	sendThreadCommand(input: AdminThreadCommandInput): Promise<AdminThreadCommandResult>;
	threads(input?: AdminPageInput): Promise<AdminPage<AdminThreadRow>>;
	thread(id: string, input?: { event?: string }): Promise<AdminThreadView | undefined>;
	approvals(input?: AdminPageInput): Promise<AdminPage<Approval>>;
	jobs(input?: AdminPageInput): Promise<AdminPage<AdminJob>>;
	evals(input?: AdminPageInput): Promise<AdminPage<AdminEval>>;
	memory(input?: AdminPageInput): Promise<AdminMemory>;
};

export type AdminSendMessageInput = {
	text: string;
	threadId?: string;
	actor?: string;
};

export type AdminSendMessageResult = {
	threadId: string;
	trace: string;
	status: "done" | "pending_approval" | "silent";
};

export type AdminResolveApprovalInput = {
	id: string;
	action: "approve" | "deny";
	actor?: string;
};

export type AdminResolveApprovalResult = {
	threadId?: string;
	trace: string;
	status: "done" | "pending_approval" | "silent";
};

export type AdminThreadCommandInput = {
	threadId: string;
	text: string;
	actor?: string;
};

export type AdminThreadCommandResult = {
	threadId: string;
	trace: string;
	status: "done" | "pending_approval" | "silent";
};

export type AdminOverview = {
	agent: { id: string; directory?: string; model?: string };
	runtime: { name: string; root: string };
	task: Required<TaskConfig>;
	approval?: ApprovalConfig;
	activeBypasses: ApprovalBypass[];
	startedAt: number;
	adapters: Array<{ name: string; kind: string; permissions?: PermissionsConfig }>;
	memory: AdminMemory;
	threads: number;
	live: AdminLiveSummary;
};

type AdminLiveSummary = {
	pendingApprovals: number;
	runningRuns: number;
	jobs: number;
	activeJobs: number;
	pausedJobs: number;
	recentCalls: number;
	checkedAt: number;
	revision: string;
	chatsRevision: string;
	threadRevisions: Record<string, string>;
};

export type AdminJob = Job & { route?: string; lastRun?: JobRun | null };

export type AdminEval = {
	name: string;
	prompt: string;
	tags: string[];
	timeoutMs?: number;
	expect: string;
};

export type AdminThreadRow = {
	id: string;
	provider: string;
	kind: string;
	team?: string;
	channel: string;
	actor?: string;
	state: string;
	title: string;
	summary: string;
	createdAt: number;
	updatedAt: number;
	lastActivityAt: number;
	pendingApprovals: number;
	runningRuns: number;
	latestEvent?: string;
};

export type AdminThreadView = {
	thread: AdminThreadRow;
	timeline: AdminActivityRow[];
	selected?: AdminActivityRow;
	event?: string;
};

export type AdminActivityDetail = {
	label: string;
	value: string;
	format?: "mono" | "text";
};

export type AdminActivityRow = {
	id: string;
	kind: "approval" | "call" | "event" | "message" | "run";
	threadId?: string;
	title: string;
	summary: string;
	state: string;
	trace?: string;
	provider?: string;
	eventType?: string;
	role?: string;
	channel?: string;
	actor?: string;
	time: number;
	durationMs?: number;
	seq?: number;
	details?: AdminActivityDetail[];
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
	truncated?: boolean;
	filters?: AdminPageFilters;
	facets?: AdminFilterFacets;
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
const ADMIN_SCAN_LIMIT = 500;

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
			const activeBypasses = await (store.approvalBypasses?.listActive({ agent: app.agent, limit: 25 }) ?? []);
			return {
				agent: {
					id: app.agent,
					directory: app.agentDirectory,
					model: app.agentModel ? `${app.agentModel.provider}/${app.agentModel.name}` : undefined,
				},
				runtime: app.runtime,
				task: app.task ?? { busy: "steer", cancel: "initiator" },
				approval: app.approval,
				activeBypasses,
				startedAt: app.startedAt,
				adapters: app.adapters,
				memory,
				threads: threads.length,
				live,
			};
		},
		async live(): Promise<AdminLiveSummary> {
			const [approvals, bypasses, jobs, runningRuns, recentTurns, recentThreads, recentMessages, calls] =
				await Promise.all([
					store.approvals.listPending({ agent: app.agent, limit: 100 }),
					store.approvalBypasses?.listActive({ agent: app.agent, limit: 100 }) ?? [],
					store.jobs?.list({ agent: app.agent, limit: 1000 }) ?? [],
					store.turns.listRunning?.({ agent: app.agent, limit: 100 }) ?? [],
					store.turns.listRecent?.({ agent: app.agent, limit: 100 }) ?? [],
					store.threads.list({ agent: app.agent, limit: 100 }),
					store.messages.listRecent?.({ agent: app.agent, limit: 100 }) ?? [],
					store.calls.listRecent?.({ agent: app.agent, limit: 100 }) ?? [],
				]);
			const checkedAt = Date.now();
			const threadRevisionRows = [
				...approvals
					.filter((row) => row.threadId)
					.map((row) => [row.threadId, "approval", row.id, row.state, row.requestedAt, row.resolvedAt] as const),
				...runningRuns
					.filter((row) => row.threadId)
					.map((row) => [row.threadId, "running-run", row.id, row.state, row.updatedAt] as const),
				...recentTurns
					.filter((row) => row.threadId)
					.map((row) => [row.threadId, "turn", row.id, row.state, row.channel, row.actor, row.updatedAt] as const),
				...recentThreads.map((row) => [row.id, "thread", row.id, row.channel, row.actor, row.updatedAt] as const),
				...recentMessages
					.filter((row) => row.threadId)
					.map(
						(row) =>
							[row.threadId, "message", row.id, row.state, row.actor, row.createdAt, row.updatedAt] as const,
					),
				...calls
					.filter((row) => row.threadId)
					.map((row) => [row.threadId, "call", row.id, row.state, row.updatedAt] as const),
			];
			const revision = revisionHash([
				...approvals.map((row) => ["approval", row.id, row.state, row.requestedAt, row.resolvedAt]),
				...jobs.map((row) => ["job", row.id, row.state, row.nextAt, row.lastAt, row.updatedAt]),
				...runningRuns.map((row) => ["run", row.id, row.state, row.updatedAt]),
				...recentTurns.map((row) => ["turn", row.id, row.state, row.channel, row.actor, row.updatedAt]),
				...recentThreads.map((row) => ["thread", row.id, row.channel, row.actor, row.updatedAt]),
				...recentMessages.map((row) => ["message", row.id, row.state, row.actor, row.createdAt, row.updatedAt]),
				...calls.map((row) => ["call", row.id, row.state, row.updatedAt]),
				...bypasses.map((row) => [
					"bypass",
					row.id,
					row.scope,
					row.channel,
					row.threadId,
					row.actor,
					row.expiresAt,
				]),
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
				chatsRevision: revisionHash(threadRevisionRows),
				threadRevisions: threadRevisionMap(threadRevisionRows),
			};
		},
		async sendMessage(input: AdminSendMessageInput): Promise<AdminSendMessageResult> {
			const text = input.text.trim();
			if (!text) throw new Error("message text is required");
			const existing = input.threadId ? await store.threads.get(input.threadId) : undefined;
			if (input.threadId && (!existing || existing.agent !== app.agent)) throw new Error("thread not found");
			const key = existing?.key ?? `admin:${randomUUID()}`;
			const trace = `admin:${randomUUID()}`;
			const actor = input.actor?.trim() || existing?.actor || "admin";
			const result = await start.handler({
				provider: existing?.provider ?? "local",
				kind: existing?.kind ?? "local",
				team: existing?.team || undefined,
				channel: existing?.channel ?? key,
				actor,
				thread: key,
				text,
				trace,
				eventId: trace,
				data: { source: "admin" },
			});
			const thread = existing ?? (await store.threads.getByKey(app.agent, "local", undefined, key));
			if (!thread) throw new Error("admin message did not create a thread");
			return {
				threadId: thread.id,
				trace,
				status: result?.approval ? "pending_approval" : result?.silent ? "silent" : "done",
			};
		},
		async resolveApproval(input: AdminResolveApprovalInput): Promise<AdminResolveApprovalResult> {
			const approval = await store.approvals.get(input.id, { agent: app.agent });
			if (!approval || approval.state !== "pending") throw new Error("approval not found");
			const actor = input.actor?.trim() || "admin";
			const trace = `admin:${randomUUID()}`;
			const thread = approval.threadId ? await store.threads.get(approval.threadId) : undefined;
			const route = thread
				? {
						provider: thread.provider,
						kind: thread.kind,
						team: thread.team ?? undefined,
						channel: thread.channel,
						thread: thread.key,
					}
				: approvalRoute(approval);
			const result = await start.handler({
				provider: route.provider,
				kind: route.kind,
				team: route.team,
				channel: route.channel,
				actor,
				thread: route.thread,
				text: `/${input.action} ${approval.id}`,
				trace,
				eventId: trace,
				data: { source: "admin", approvalId: approval.id, action: input.action },
			});
			return {
				threadId: thread?.id,
				trace,
				status: result?.approval ? "pending_approval" : result?.silent ? "silent" : "done",
			};
		},
		async sendThreadCommand(input: AdminThreadCommandInput): Promise<AdminThreadCommandResult> {
			const text = input.text.trim();
			if (!text) throw new Error("command text is required");
			const thread = await store.threads.get(input.threadId);
			if (!thread || thread.agent !== app.agent) throw new Error("thread not found");
			const trace = `admin:${randomUUID()}`;
			const result = await start.handler({
				provider: thread.provider,
				kind: thread.kind,
				team: thread.team || undefined,
				channel: thread.channel,
				actor: input.actor?.trim() || "admin",
				thread: thread.key,
				text,
				trace,
				eventId: trace,
				data: { source: "admin", command: text },
			});
			return {
				threadId: thread.id,
				trace,
				status: result?.approval ? "pending_approval" : result?.silent ? "silent" : "done",
			};
		},
		async threads(input: AdminPageInput = {}): Promise<AdminPage<AdminThreadRow>> {
			const page = pageInput(input);
			const filters = filtersFromInput(input);
			const [threads, recent] = await Promise.all([
				store.threads.list({ agent: app.agent, limit: 1000 }),
				recentThreadActivityRows(),
			]);
			const summaries = threadSummaries(threads, recent);
			const facets = rowFacets(summaries, {
				provider: (row) => row.provider,
				channel: (row) => row.channel,
				actor: (row) => row.actor,
			});
			return {
				...toPage(
					filterRows(summaries, filters, threadSearchText),
					page,
					filters,
					page.offset,
					threads.length >= 1000,
				),
				facets,
			};
		},
		async thread(id: string, input: { event?: string } = {}): Promise<AdminThreadView | undefined> {
			const thread = await store.threads.get(id);
			if (!thread || thread.agent !== app.agent) return undefined;
			const timeline = await threadTimeline(thread);
			const summary = threadSummaries([thread], timeline)[0];
			const selected =
				timeline.find((row) => activityEvent(row) === input.event || row.id === input.event) ?? timeline[0];
			return { thread: summary, timeline, selected, event: selected ? activityEvent(selected) : input.event };
		},
		async approvals(input: AdminPageInput = {}): Promise<AdminPage<Approval>> {
			const page = pageInput(input);
			const filters = filtersFromInput(input);
			const [baseFacets, scan] = await Promise.all([
				knownFacets(),
				scanRows((input) => store.approvals.listPending({ agent: app.agent, ...input })),
			]);
			const facets = mergeFacets(
				baseFacets,
				rowFacets(scan.rows, {
					channel: (row) => row.channel,
					actor: (row) => row.requestedBy ?? undefined,
				}),
			);
			if (!filtersActive(filters)) {
				const rows = await store.approvals.listPending({
					agent: app.agent,
					limit: page.limit + 1,
					offset: page.offset,
				});
				return { ...toPage(rows, page, filters, 0), facets };
			}
			return {
				...toPage(filterRows(scan.rows, filters, approvalSearchText), page, filters, page.offset, scan.truncated),
				facets,
			};
		},
		async jobs(input: AdminPageInput = {}): Promise<AdminPage<AdminJob>> {
			const page = pageInput(input);
			const filters = filtersFromInput(input);
			const filtering = filtersActive(filters);
			const scan = filtering
				? await scanRows((input) => store.jobs?.list({ agent: app.agent, ...input }) ?? Promise.resolve([]))
				: undefined;
			const rows =
				scan?.rows ??
				(await (store.jobs?.list({
					agent: app.agent,
					limit: page.limit + 1,
					offset: page.offset,
				}) ?? []));
			const withRuns = await Promise.all(
				rows.map(async (job) => ({
					...job,
					route: jobRoute(job),
					lastRun: (await store.jobRuns?.lastForJob({ agent: job.agent, id: job.id })) ?? null,
				})),
			);
			return filtering && scan
				? toPage(filterRows(withRuns, filters, jobSearchText), page, filters, page.offset, scan.truncated)
				: toPage(withRuns, page, filters, 0);
		},
		async evals(input: AdminPageInput = {}): Promise<AdminPage<AdminEval>> {
			const page = pageInput(input);
			const filters = filtersFromInput(input);
			const rows = (app.evals ?? []).map(evalRow).sort((left, right) => left.name.localeCompare(right.name));
			return toPage(filterRows(rows, filters, evalSearchText), page, filters);
		},
		async memory(input: AdminPageInput = {}): Promise<AdminMemory> {
			const page = pageInput(input);
			const filters = filtersFromInput(input);
			const filtering = filtersActive(filters);
			const settings = start.memory?.settings() ?? app.memory;
			const scan = filtering
				? await scanRows((input) => start.memory?.list(input) ?? Promise.resolve([]))
				: await listPage((input) => start.memory?.list(input) ?? Promise.resolve([]), page.limit + 1, page.offset);
			const pageRows = filtering
				? filterRows(scan.rows, filters, memorySearchText).slice(page.offset, page.offset + page.limit + 1)
				: scan.rows;
			const facets = rowFacets(scan.rows, { scope: (row) => row.scopePath });
			return {
				enabled: settings.enabled,
				scope: settings.scope,
				writePolicy: settings.writePolicy,
				maxChars: settings.maxChars,
				total: await (start.memory?.count() ?? Promise.resolve(0)),
				limit: page.limit,
				offset: page.offset,
				hasNext: pageRows.length > page.limit,
				truncated: filtering ? scan.truncated : false,
				filters,
				facets,
				entries: pageRows.slice(0, page.limit),
			};
		},
	};

	async function knownFacets(): Promise<AdminFilterFacets> {
		const rows = await store.threads.list({ agent: app.agent, limit: 1000 });
		return rowFacets(rows, {
			provider: (row) => row.provider,
			channel: (row) => row.channel,
			actor: (row) => row.actor ?? undefined,
		});
	}

	async function recentThreadActivityRows(): Promise<AdminActivityRow[]> {
		const [approvals, runs, messages, calls] = await Promise.all([
			store.approvals.listPending({ agent: app.agent, limit: ADMIN_SCAN_LIMIT }),
			store.turns.listRecent?.({ agent: app.agent, limit: ADMIN_SCAN_LIMIT }) ?? [],
			store.messages.listRecent?.({ agent: app.agent, limit: ADMIN_SCAN_LIMIT }) ?? [],
			store.calls.listRecent?.({ agent: app.agent, limit: ADMIN_SCAN_LIMIT }) ?? [],
		]);
		const runMessages = await runMessageContexts(runs);
		return [
			...approvals.map(approvalActivity),
			...runs.map((row) => runActivity(row, runMessages.get(row.id))),
			...messages.map(messageActivity),
			...calls.map(callActivity),
		].sort(activitySort);
	}

	async function threadTimeline(thread: Thread): Promise<AdminActivityRow[]> {
		const [messages, runs, calls, approvals, events] = await Promise.all([
			store.messages.listForThread(thread.id, { limit: 100 }),
			store.turns.listForThread(thread.id, { limit: 25 }),
			store.calls.listForThread(thread.id, { agent: app.agent, limit: 25 }),
			store.approvals.listForThread?.(thread.id, { agent: app.agent, limit: 50 }) ??
				store.approvals.listPending({ agent: app.agent, threadId: thread.id, limit: 50 }),
			store.events?.list({ agent: app.agent, threadId: thread.id, limit: 100 }) ?? [],
		]);
		const runMessages = await runMessageContexts(runs);
		const rows = [
			...messages.map((row) => messageActivity(messageWithThread(row, thread))),
			...runs.map((row) => runActivity(row, runMessages.get(row.id))),
			...calls.map(callActivity),
			...approvals.map(approvalActivity),
			...events.map(eventActivity),
		];
		return rows.sort(activitySort);
	}

	async function runMessageContexts(rows: Turn[]): Promise<Map<string, { input?: Message; result?: Message }>> {
		const entries = await Promise.all(
			rows.map(async (row) => {
				const [input, result] = await Promise.all([
					store.messages.get(row.inputMessageId),
					row.resultMessageId ? store.messages.get(row.resultMessageId) : Promise.resolve(undefined),
				]);
				return [row.id, { input, result }] as const;
			}),
		);
		return new Map(entries);
	}

	return service;
}

function approvalActivity(row: Approval): AdminActivityRow {
	return {
		id: row.id,
		kind: "approval",
		threadId: row.threadId ?? undefined,
		title: row.command,
		summary: row.reason,
		state: row.state,
		channel: row.channel,
		actor: row.requestedBy ?? undefined,
		time: row.resolvedAt ?? row.requestedAt,
		details: compactDetails([
			{ label: "Call", value: row.callId, format: "mono" },
			row.threadId ? { label: "Thread", value: row.threadId, format: "mono" } : undefined,
			row.turnId ? { label: "Turn", value: row.turnId, format: "mono" } : undefined,
			row.requestMessageId ? { label: "Request message", value: row.requestMessageId, format: "mono" } : undefined,
			{ label: "Runtime", value: row.runtime },
			row.expiresAt ? { label: "Expires", value: new Date(row.expiresAt).toLocaleString() } : undefined,
			row.resolvedBy ? { label: "Resolved by", value: row.resolvedBy } : undefined,
		]),
	};
}

function approvalRoute(row: Approval): {
	provider: string;
	kind: string;
	team?: string;
	channel: string;
	thread: string;
} {
	const [provider, team = "", channel = row.channel] = row.channel.split(":", 3);
	if (!provider || !channel) throw new Error("approval route is unavailable");
	return {
		provider,
		kind: provider,
		team: team || undefined,
		channel,
		thread: row.threadId ?? `admin:${row.id}`,
	};
}

function eventActivity(row: Event): AdminActivityRow {
	return {
		id: row.id,
		kind: "event",
		threadId: row.threadId ?? undefined,
		title: row.type,
		summary: preview(row.data) || `trace ${row.trace}`,
		state: eventState(row.type),
		trace: row.trace,
		time: row.createdAt,
		seq: row.seq,
		details: compactDetails([
			{ label: "Trace", value: row.trace, format: "mono" },
			{ label: "Sequence", value: String(row.seq), format: "mono" },
			row.turnId ? { label: "Turn", value: row.turnId, format: "mono" } : undefined,
			row.callId ? { label: "Call", value: row.callId, format: "mono" } : undefined,
			row.approvalId ? { label: "Approval", value: row.approvalId, format: "mono" } : undefined,
			row.jobRunId ? { label: "Job run", value: row.jobRunId, format: "mono" } : undefined,
			row.data ? { label: "Data", value: row.data, format: "text" } : undefined,
		]),
	};
}

function eventState(type: string): string {
	const suffix = type.split(".").at(-1);
	if (suffix === "started" || suffix === "requested") return "running";
	if (suffix === "failed") return "failed";
	if (suffix === "cancelled") return "cancelled";
	if (suffix === "expired") return "expired";
	if (suffix === "resolved" || suffix === "completed" || suffix === "sent" || suffix === "received") return "done";
	return "event";
}

function jobRoute(row: Pick<Job, "scope" | "target">): string | undefined {
	const targets = parseJson<JobTargets>(row.target);
	if (targets) return routeText(targets, "targets");
	const scope = parseJson<JobScope>(row.scope);
	if (scope) return routeText(scope, "scope");
	return row.target ?? row.scope ?? undefined;
}

function routeText(input: JobTargets | JobScope, kind: "targets" | "scope"): string {
	const entries = Object.entries(input) as Array<[string, { channels?: string[]; users?: string[] }]>;
	const rows = entries.flatMap(([adapter, route]) => {
		const parts = [ids("channel", route.channels), ids("user", route.users)].filter(Boolean);
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

function runActivity(row: Turn, messages?: { input?: Message; result?: Message }): AdminActivityRow {
	const input = messages?.input?.text;
	const result = messages?.result?.text;
	return {
		id: row.id,
		kind: "run",
		threadId: row.threadId,
		title: preview(input) || row.trace || row.id,
		summary: preview(result) || `${row.provider}/${row.kind}`,
		state: row.state,
		provider: row.provider,
		eventType: row.kind,
		channel: row.channel,
		actor: row.actor ?? undefined,
		time: row.updatedAt,
		details: compactDetails([
			row.trace ? { label: "Trace", value: row.trace, format: "mono" } : undefined,
			{ label: "Thread", value: row.threadId, format: "mono" },
			{ label: "Input message", value: row.inputMessageId, format: "mono" },
			input ? { label: "Input", value: input, format: "text" } : undefined,
			row.resultMessageId ? { label: "Result message", value: row.resultMessageId, format: "mono" } : undefined,
			result ? { label: "Result", value: result, format: "text" } : undefined,
		]),
	};
}

function messageActivity(row: MessageWithThread): AdminActivityRow {
	return {
		id: row.id,
		kind: "message",
		threadId: row.threadId,
		title: preview(row.text) || "Empty message",
		summary: [row.role, row.provider, row.kind].filter(Boolean).join(" / "),
		state: row.state,
		provider: row.provider,
		eventType: row.kind,
		role: row.role,
		channel: row.channel,
		actor: row.actor ?? row.threadActor ?? undefined,
		time: row.createdAt,
		details: compactDetails([
			{ label: "Thread", value: row.threadId, format: "mono" },
			row.providerEventId ? { label: "Provider event", value: row.providerEventId, format: "mono" } : undefined,
			{ label: "Text", value: row.text, format: "text" },
		]),
	};
}

function callActivity(row: Call): AdminActivityRow {
	return {
		id: row.id,
		kind: "call",
		threadId: row.threadId ?? undefined,
		title: row.tool,
		summary: row.command ?? row.args ?? "",
		state: row.state,
		channel: row.channel,
		actor: row.actor ?? undefined,
		time: row.updatedAt,
		durationMs: row.ms ?? undefined,
		details: compactDetails([
			row.threadId ? { label: "Thread", value: row.threadId, format: "mono" } : undefined,
			row.turnId ? { label: "Turn", value: row.turnId, format: "mono" } : undefined,
			row.messageId ? { label: "Message", value: row.messageId, format: "mono" } : undefined,
			row.toolCallId ? { label: "Tool call", value: row.toolCallId, format: "mono" } : undefined,
			row.runtime ? { label: "Runtime", value: row.runtime } : undefined,
			row.policyReason ? { label: "Policy", value: row.policyReason } : undefined,
			row.out ? { label: "Stdout", value: row.out, format: "text" } : undefined,
			row.err ? { label: "Stderr", value: row.err, format: "text" } : undefined,
		]),
	};
}

function messageWithThread(row: Message, thread: Thread): MessageWithThread {
	return {
		...row,
		agent: thread.agent,
		channel: thread.channel,
		threadActor: thread.actor,
	};
}

function threadSummaries(threads: Thread[], activity: AdminActivityRow[]): AdminThreadRow[] {
	const byThread = new Map<string, AdminActivityRow[]>();
	for (const row of activity) {
		if (!row.threadId) continue;
		const rows = byThread.get(row.threadId) ?? [];
		rows.push(row);
		byThread.set(row.threadId, rows);
	}
	return threads
		.map((thread) => threadSummary(thread, byThread.get(thread.id) ?? []))
		.sort((left, right) => right.lastActivityAt - left.lastActivityAt || left.channel.localeCompare(right.channel));
}

function threadSummary(row: Thread, activity: AdminActivityRow[]): AdminThreadRow {
	const sorted = [...activity].sort(activitySort);
	const latest = sorted[0];
	const latestMessage = sorted.find((item) => item.kind === "message");
	const pendingApprovals = activity.filter((item) => item.kind === "approval" && item.state === "pending").length;
	const runningRuns = activity.filter((item) => item.kind === "run" && item.state === "running").length;
	const failed = latest?.state === "failed";
	const state = pendingApprovals ? "pending_approval" : runningRuns ? "running" : failed ? "failed" : "idle";
	const summary = latestMessage?.title ?? (latest ? `${kindText(latest.kind)}: ${latest.title}` : "No activity yet");
	return {
		id: row.id,
		provider: row.provider,
		kind: row.kind,
		team: row.team ?? undefined,
		channel: row.channel,
		actor: row.actor ?? undefined,
		state,
		title: row.actor ? `${row.channel} · ${row.actor}` : row.channel,
		summary,
		createdAt: row.createdAt,
		updatedAt: row.updatedAt,
		lastActivityAt: latest?.time ?? row.updatedAt,
		pendingApprovals,
		runningRuns,
		latestEvent: latest ? activityEvent(latest) : undefined,
	};
}

export function activityEvent(row: AdminActivityRow): string {
	return `${row.kind}:${row.id}`;
}

function activitySort(left: AdminActivityRow, right: AdminActivityRow): number {
	return (
		right.time - left.time ||
		(right.seq ?? Number.NEGATIVE_INFINITY) - (left.seq ?? Number.NEGATIVE_INFINITY) ||
		left.kind.localeCompare(right.kind) ||
		left.id.localeCompare(right.id)
	);
}

function kindText(kind: AdminActivityRow["kind"]): string {
	const labels: Record<AdminActivityRow["kind"], string> = {
		approval: "Approval",
		call: "Tool call",
		event: "Event",
		message: "Message",
		run: "Run",
	};
	return labels[kind];
}

function preview(input: string | null | undefined): string {
	const value = input?.trim().replace(/\s+/gu, " ");
	if (!value) return "";
	return value.length > 240 ? `${value.slice(0, 237)}...` : value;
}

function compactDetails(input: Array<AdminActivityDetail | undefined>): AdminActivityDetail[] {
	return input.filter((row): row is AdminActivityDetail => row !== undefined && Boolean(row.value));
}

function pageInput(input: AdminPageInput): Pick<AdminPage<never>, "limit" | "offset"> {
	const rawLimit = finitePageNumber(input.limit, DEFAULT_LIMIT);
	const rawOffset = finitePageNumber(input.offset, 0);
	const limit = clampLimit(Math.trunc(rawLimit), DEFAULT_LIMIT, MAX_LIMIT);
	const offset = clampOffset(Math.trunc(rawOffset));
	return { limit, offset };
}

function finitePageNumber(input: number | undefined, fallback: number): number {
	return input === undefined || !Number.isFinite(input) ? fallback : input;
}

function toPage<T>(
	rows: T[],
	page: Pick<AdminPage<T>, "limit" | "offset">,
	filters?: AdminPageFilters,
	sliceOffset = page.offset,
	truncated = false,
): AdminPage<T> {
	const pageRows = rows.slice(sliceOffset, sliceOffset + page.limit + 1);
	return {
		rows: pageRows.slice(0, page.limit),
		limit: page.limit,
		offset: page.offset,
		hasNext: pageRows.length > page.limit,
		truncated,
		filters,
	};
}

async function scanRows<T>(
	list: (input: { limit: number; offset?: number }) => Promise<T[]>,
): Promise<{ rows: T[]; truncated: boolean }> {
	const rows = await list({ limit: ADMIN_SCAN_LIMIT, offset: 0 });
	if (rows.length < ADMIN_SCAN_LIMIT) return { rows, truncated: false };
	const next = await list({ limit: 1, offset: rows.length });
	return { rows, truncated: next.length > 0 };
}

async function listPage<T>(
	list: (input: { limit: number; offset?: number }) => Promise<T[]>,
	limit: number,
	offset = 0,
): Promise<{ rows: T[]; truncated: boolean }> {
	return { rows: await list({ limit, offset }), truncated: false };
}

function filtersFromInput(input: AdminPageInput): AdminPageFilters {
	return compactFilters({
		q: cleanFilter(input.q),
		provider: cleanFilter(input.provider),
		type: cleanFilter(input.type),
		state: cleanFilter(input.state),
		channel: cleanFilter(input.channel),
		actor: cleanFilter(input.actor),
		scope: cleanFilter(input.scope),
	});
}

function compactFilters(input: AdminPageFilters): AdminPageFilters {
	const out: AdminPageFilters = {};
	for (const key of ["q", "provider", "type", "state", "channel", "actor", "scope"] as const) {
		if (input[key]) out[key] = input[key];
	}
	return out;
}

function cleanFilter(input: string | undefined): string | undefined {
	const value = input?.trim();
	return value ? value.slice(0, 120) : undefined;
}

function filterRows<T>(
	rows: T[],
	filters: AdminPageFilters,
	input: {
		search: (row: T) => Array<string | number | null | undefined>;
		provider?: (row: T) => string | undefined;
		type?: (row: T) => string | undefined;
		state?: (row: T) => string | undefined;
		channel?: (row: T) => string | undefined;
		actor?: (row: T) => string | undefined;
		scope?: (row: T) => string | undefined;
	},
): T[] {
	return rows.filter((row) => {
		if (filters.provider && input.provider?.(row) !== filters.provider) return false;
		if (filters.type && input.type?.(row) !== filters.type) return false;
		if (filters.state && input.state?.(row) !== filters.state) return false;
		if (!includesFilter(input.channel?.(row), filters.channel)) return false;
		if (!includesFilter(input.actor?.(row), filters.actor)) return false;
		if (!includesFilter(input.scope?.(row), filters.scope)) return false;
		if (!filters.q) return true;
		const query = filters.q.toLowerCase();
		return input.search(row).some((value) =>
			String(value ?? "")
				.toLowerCase()
				.includes(query),
		);
	});
}

function includesFilter(value: string | undefined, filter: string | undefined): boolean {
	return !filter || (value ?? "").toLowerCase().includes(filter.toLowerCase());
}

function filtersActive(filters: AdminPageFilters): boolean {
	return Object.values(filters).some(Boolean);
}

function rowFacets<T>(
	rows: T[],
	input: {
		provider?: (row: T) => string | undefined;
		channel?: (row: T) => string | undefined;
		actor?: (row: T) => string | undefined;
		scope?: (row: T) => string | undefined;
	},
): AdminFilterFacets {
	return {
		providers: sortedValues(rows.map((row) => input.provider?.(row))),
		channels: sortedValues(rows.map((row) => input.channel?.(row))),
		actors: sortedValues(rows.map((row) => input.actor?.(row))),
		scopes: sortedValues(rows.map((row) => input.scope?.(row))),
	};
}

function mergeFacets(...facets: AdminFilterFacets[]): AdminFilterFacets {
	return {
		providers: sortedValues(facets.flatMap((facet) => facet.providers)),
		channels: sortedValues(facets.flatMap((facet) => facet.channels)),
		actors: sortedValues(facets.flatMap((facet) => facet.actors)),
		scopes: sortedValues(facets.flatMap((facet) => facet.scopes)),
	};
}

function sortedValues(input: Array<string | null | undefined>): string[] {
	return [...new Set(input.filter((value): value is string => Boolean(value)))].sort((left, right) =>
		left.localeCompare(right),
	);
}

const approvalSearchText = {
	search: (row: Approval): Array<string | number | null | undefined> => [
		row.id,
		row.callId,
		row.command,
		row.runtime,
		row.reason,
		row.channel,
		row.requestedBy,
		row.state,
	],
	state: (row: Approval) => row.state,
	channel: (row: Approval) => row.channel,
	actor: (row: Approval) => row.requestedBy ?? undefined,
};

const jobSearchText = {
	search: (row: AdminJob): Array<string | number | null | undefined> => [
		row.id,
		row.kind,
		row.schedule,
		row.route,
		row.prompt,
		row.state,
		row.nextAt,
		row.lastAt,
	],
	type: (row: AdminJob) => row.kind,
	state: (row: AdminJob) => row.state,
};

const evalSearchText = {
	search: (row: AdminEval): Array<string | number | null | undefined> => [
		row.name,
		row.prompt,
		row.tags.join(" "),
		row.timeoutMs,
		row.expect,
	],
};

const threadSearchText = {
	search: (row: AdminThreadRow): Array<string | number | null | undefined> => [
		row.id,
		row.provider,
		row.kind,
		row.team,
		row.channel,
		row.actor,
		row.state,
		row.title,
		row.summary,
		row.pendingApprovals,
		row.runningRuns,
	],
	provider: (row: AdminThreadRow) => row.provider,
	state: (row: AdminThreadRow) => row.state,
	channel: (row: AdminThreadRow) => row.channel,
	actor: (row: AdminThreadRow) => row.actor,
};

function evalRow(row: EvalConfig): AdminEval {
	return {
		name: row.name,
		prompt: row.prompt,
		tags: row.tags ?? [],
		timeoutMs: row.timeoutMs,
		expect: evalExpectLabel(row.expect),
	};
}

function evalExpectLabel(input: EvalConfig["expect"]): string {
	if (!input) return "-";
	const rows = Array.isArray(input) ? input : [input];
	return rows.map(oneEvalExpectLabel).join(", ");
}

function oneEvalExpectLabel(input: EvalExpect): string {
	if (typeof input === "function") return "custom";
	return Object.entries(input)
		.map(([key, value]) => `${key}:${value instanceof RegExp ? value.toString() : String(value)}`)
		.join("+");
}

const memorySearchText = {
	search: (row: AdminMemory["entries"][number]): Array<string | number | null | undefined> => [
		row.scopePath,
		row.path,
		row.text,
		row.sha256,
		row.size,
	],
	scope: (row: AdminMemory["entries"][number]) => row.scopePath,
};

function revisionHash(input: unknown): string {
	return createHash("sha256").update(JSON.stringify(input)).digest("hex").slice(0, 16);
}

function threadRevisionMap(input: Array<readonly [string | null | undefined, ...unknown[]]>): Record<string, string> {
	const rows = new Map<string, unknown[][]>();
	for (const [threadId, ...rest] of input) {
		if (!threadId) continue;
		const threadRows = rows.get(threadId) ?? [];
		threadRows.push(rest);
		rows.set(threadId, threadRows);
	}
	return Object.fromEntries([...rows].map(([threadId, rows]) => [threadId, revisionHash(rows)]));
}

function required<T>(input: T | undefined, message: string): T {
	if (input === undefined) throw new Error(message);
	return input;
}

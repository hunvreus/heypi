import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "@sinclair/typebox";

export type TodoStatus = "pending" | "in_progress" | "completed" | "failed" | "canceled" | "unknown";

type TodoInputStatus = Exclude<TodoStatus, "unknown">;

export type TodoItem = {
	id: string;
	text: string;
	status: TodoStatus;
	updatedAt: Date;
};

export type TodoUpdate = {
	items: TodoItem[];
	active: boolean;
	updatedAt?: Date;
};

export type TodoExtensionOptions = {
	render(update: TodoUpdate): Promise<void>;
	now?(): Date;
};

export type TodoController = {
	extension: ExtensionFactory;
	reset(): void;
	complete(): Promise<void>;
	fail(): Promise<void>;
	cancel(): Promise<void>;
};

type TodoSnapshot = {
	version: 1;
	items: Array<Omit<TodoItem, "updatedAt"> & { updatedAt: string }>;
	updatedAt?: string;
};

const TODO_ENTRY = "heypi.todo";

const TODO_SYMBOLS: Record<TodoStatus, string> = {
	pending: "○",
	in_progress: "●",
	completed: "✓",
	failed: "✕",
	canceled: "⊘",
	unknown: "?",
};

const inputStatuses = ["pending", "in_progress", "completed", "failed", "canceled"] as const;

const todoParameters = Type.Object({
	items: Type.Array(
		Type.Object({
			id: Type.String({ minLength: 1 }),
			text: Type.String({ minLength: 1 }),
			status: Type.Union(inputStatuses.map((status) => Type.Literal(status))),
		}),
		{ minItems: 1 },
	),
});

type TodoParams = Static<typeof todoParameters>;

function statusLine(item: TodoItem): string {
	return `${TODO_SYMBOLS[item.status]} ${item.text}`;
}

function timeText(date: Date): string {
	return new Intl.DateTimeFormat(undefined, {
		hour: "2-digit",
		minute: "2-digit",
		hour12: false,
	}).format(date);
}

function relativeTime(date: Date, now = new Date()): string {
	const seconds = Math.max(0, Math.floor((now.getTime() - date.getTime()) / 1000));
	if (seconds < 60) return "just now";
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m ago`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours}h ago`;
	const days = Math.floor(hours / 24);
	return `${days}d ago`;
}

/** Render the adapter-neutral todo status message. */
export function renderTodo(update: TodoUpdate, now = new Date()): string {
	const lines = update.items.map(statusLine);
	if (update.active && update.updatedAt) {
		lines.push("", `Last updated ${timeText(update.updatedAt)} (${relativeTime(update.updatedAt, now)})`);
	}
	return lines.join("\n");
}

function clone(items: TodoItem[]): TodoItem[] {
	return items.map((item) => ({ ...item, updatedAt: new Date(item.updatedAt) }));
}

function terminal(status: TodoStatus): boolean {
	return status === "completed" || status === "failed" || status === "canceled" || status === "unknown";
}

function unresolved(items: TodoItem[]): boolean {
	return items.some((item) => item.status === "pending" || item.status === "in_progress");
}

function normalize(current: TodoItem[], input: TodoParams["items"], now: Date): TodoItem[] {
	const previous = new Map(current.map((item) => [item.id, item]));
	const seen = new Set<string>();
	let active = 0;
	const next = input.map((item) => {
		if (seen.has(item.id)) throw new Error(`Duplicate todo id: ${item.id}`);
		seen.add(item.id);
		if (item.status === "in_progress") active += 1;
		const existing = previous.get(item.id);
		if (existing && terminal(existing.status) && existing.status !== item.status) {
			throw new Error(`Todo ${item.id} cannot move from ${existing.status} to ${item.status}.`);
		}
		const changed = !existing || existing.text !== item.text || existing.status !== item.status;
		return {
			id: item.id,
			text: item.text,
			status: item.status as TodoInputStatus,
			updatedAt: changed ? now : existing.updatedAt,
		};
	});
	if (active > 1) throw new Error("Only one todo item may be in progress.");
	if (active === 0) {
		const first = next.find((item) => item.status === "pending");
		if (first) {
			first.status = "in_progress";
			first.updatedAt = now;
		}
	}
	return next;
}

function snapshot(items: TodoItem[], updatedAt?: Date): TodoSnapshot {
	return {
		version: 1,
		items: items.map((item) => ({ ...item, updatedAt: item.updatedAt.toISOString() })),
		updatedAt: updatedAt?.toISOString(),
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function restore(value: unknown): { items: TodoItem[]; updatedAt?: Date } | undefined {
	if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.items)) return undefined;
	const items: TodoItem[] = [];
	for (const raw of value.items) {
		if (!isRecord(raw)) return undefined;
		if (typeof raw.id !== "string" || typeof raw.text !== "string" || typeof raw.updatedAt !== "string") {
			return undefined;
		}
		if (
			raw.status !== "pending" &&
			raw.status !== "in_progress" &&
			raw.status !== "completed" &&
			raw.status !== "failed" &&
			raw.status !== "canceled" &&
			raw.status !== "unknown"
		) {
			return undefined;
		}
		const date = new Date(raw.updatedAt);
		if (Number.isNaN(date.getTime())) return undefined;
		items.push({ id: raw.id, text: raw.text, status: raw.status, updatedAt: date });
	}
	const date = typeof value.updatedAt === "string" ? new Date(value.updatedAt) : undefined;
	if (date && Number.isNaN(date.getTime())) return undefined;
	return { items, updatedAt: date };
}

function toolText(items: TodoItem[]): string {
	return JSON.stringify({
		items: items.map(({ id, text, status }) => ({ id, text, status })),
		summary: {
			pending: items.filter((item) => item.status === "pending").length,
			inProgress: items.filter((item) => item.status === "in_progress").length,
			completed: items.filter((item) => item.status === "completed").length,
			failed: items.filter((item) => item.status === "failed").length,
			canceled: items.filter((item) => item.status === "canceled").length,
		},
	});
}

/** Create the Pi todo extension and its adapter-facing lifecycle controller. */
export function createTodoController(options: TodoExtensionOptions): TodoController {
	const now = options.now ?? (() => new Date());
	let items: TodoItem[] = [];
	let updatedAt: Date | undefined;
	let reconcileRequested = false;
	let persist = () => {};

	async function render(active: boolean): Promise<void> {
		if (items.length === 0) return;
		await options.render({ items: clone(items), active, updatedAt });
	}

	function save(): void {
		persist();
	}

	async function mutate(params: TodoParams): Promise<TodoSnapshot> {
		const date = now();
		items = normalize(items, params.items, date);
		updatedAt = date;
		save();
		await render(true);
		return snapshot(items, updatedAt);
	}

	async function settle(status: "completed" | "failed" | "canceled"): Promise<void> {
		if (items.length === 0) return;
		const date = now();
		items = items.map((item) => {
			if (item.status !== "pending" && item.status !== "in_progress") return item;
			if (status === "canceled") return { ...item, status: "canceled", updatedAt: date };
			if (status === "failed" && item.status === "in_progress") {
				return { ...item, status: "failed", updatedAt: date };
			}
			return { ...item, status: "unknown", updatedAt: date };
		});
		updatedAt = date;
		save();
		await render(false);
	}

	return {
		reset() {
			items = [];
			updatedAt = undefined;
			reconcileRequested = false;
			save();
		},
		extension(pi) {
			persist = () => pi.appendEntry(TODO_ENTRY, snapshot(items, updatedAt));
			pi.on("session_start", (_event, context) => {
				let latest: { items: TodoItem[]; updatedAt?: Date } | undefined;
				for (const entry of context.sessionManager.getBranch()) {
					if (entry.type !== "custom" || entry.customType !== TODO_ENTRY) continue;
					latest = restore(entry.data) ?? latest;
				}
				if (!latest) return;
				items = latest.items;
				updatedAt = latest.updatedAt;
			});
			pi.on("agent_end", (event) => {
				const lastAssistant = [...event.messages].reverse().find((message) => message.role === "assistant");
				if (
					!unresolved(items) ||
					reconcileRequested ||
					(lastAssistant?.role === "assistant" &&
						(lastAssistant.stopReason === "error" || lastAssistant.stopReason === "aborted"))
				) {
					return;
				}
				reconcileRequested = true;
				pi.sendMessage(
					{
						customType: "heypi.todo.reconcile",
						content:
							"Before finishing, call todo once with the complete final task list. Mark every item completed, failed, or canceled, then provide the final answer again.",
						display: false,
					},
					{ triggerTurn: true, deliverAs: "followUp" },
				);
			});
			pi.registerTool({
				name: "todo",
				label: "Todo",
				description:
					"Replace the visible task list for the current chat task. Every call returns the complete normalized list.",
				promptSnippet: "Track substantial multi-step work with todo.",
				promptGuidelines: [
					"Use todo for substantial work with at least three meaningful steps. Skip it for trivial questions.",
					"Create the complete list before work and keep exactly one unresolved item in_progress.",
					"Rewrite the complete list immediately after each item completes, fails, or is canceled, before using another tool.",
					"Do not provide the final answer while todo items remain pending or in_progress.",
					"Keep item ids stable and task text short and outcome-focused.",
				],
				parameters: todoParameters,
				async execute(_toolCallId, params, signal) {
					signal?.throwIfAborted?.();
					const details = await mutate(params as TodoParams);
					return {
						content: [{ type: "text", text: toolText(items) }],
						details,
					};
				},
			});
		},
		complete() {
			return settle("completed");
		},
		fail() {
			return settle("failed");
		},
		cancel() {
			return settle("canceled");
		},
	};
}

/** Create a standalone Pi todo extension. */
export function createTodoExtension(options: TodoExtensionOptions): ExtensionFactory {
	return createTodoController(options).extension;
}

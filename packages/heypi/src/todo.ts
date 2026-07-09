import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "@sinclair/typebox";

export type TodoStatus = "pending" | "in_progress" | "completed" | "failed" | "canceled";

export type TodoItem = {
	id: number;
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

const TODO_SYMBOLS: Record<TodoStatus, string> = {
	pending: "○",
	in_progress: "●",
	completed: "✓",
	failed: "✕",
	canceled: "⊘",
};

const todoParameters = Type.Union([
	Type.Object({
		action: Type.Literal("plan"),
		items: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
		start: Type.Optional(Type.Number({ minimum: 1 })),
	}),
	Type.Object({
		action: Type.Literal("create"),
		text: Type.String({ minLength: 1 }),
		start: Type.Optional(Type.Boolean()),
	}),
	Type.Object({
		action: Type.Union([
			Type.Literal("start"),
			Type.Literal("complete"),
			Type.Literal("fail"),
			Type.Literal("cancel"),
		]),
		id: Type.Optional(Type.Number({ minimum: 1 })),
	}),
	Type.Object({
		action: Type.Literal("clear"),
	}),
]);

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

function activeItem(items: TodoItem[]): TodoItem | undefined {
	return items.find((item) => item.status === "in_progress");
}

function requireTarget(items: TodoItem[], id?: number): TodoItem | undefined {
	if (id !== undefined) return items.find((item) => item.id === id);
	return activeItem(items);
}

function transition(item: TodoItem, status: TodoStatus, now: Date): TodoItem {
	return { ...item, status, updatedAt: now };
}

function startTask(items: TodoItem[], id: number, now: Date): TodoItem[] {
	return items.map((item) => {
		if (item.id === id) return transition(item, "in_progress", now);
		if (item.status === "in_progress") return transition(item, "pending", now);
		return item;
	});
}

function apply(
	items: TodoItem[],
	nextId: number,
	params: TodoParams,
	now: Date,
): { items: TodoItem[]; nextId: number } {
	if (params.action === "plan") {
		const startId = params.start;
		const planned = params.items.map((text, index) => ({
			id: index + 1,
			text,
			status: startId === index + 1 ? ("in_progress" as const) : ("pending" as const),
			updatedAt: now,
		}));
		return { items: planned, nextId: planned.length + 1 };
	}

	if (params.action === "create") {
		const item: TodoItem = {
			id: nextId,
			text: params.text,
			status: "pending",
			updatedAt: now,
		};
		const nextItems = [...items, item];
		return {
			items: params.start === true ? startTask(nextItems, item.id, now) : nextItems,
			nextId: nextId + 1,
		};
	}

	if (params.action === "clear") {
		return { items: [], nextId: 1 };
	}

	const target = requireTarget(items, params.id);
	if (!target) return { items, nextId };
	if (params.action === "start") return { items: startTask(items, target.id, now), nextId };

	const status = params.action === "complete" ? "completed" : params.action === "fail" ? "failed" : "canceled";
	return {
		items: items.map((item) => (item.id === target.id ? transition(item, status, now) : item)),
		nextId,
	};
}

export function createTodoController(options: TodoExtensionOptions): TodoController {
	const now = options.now ?? (() => new Date());
	let items: TodoItem[] = [];
	let nextId = 1;
	let updatedAt: Date | undefined;

	async function render(active: boolean): Promise<void> {
		if (items.length === 0) return;
		await options.render({ items: clone(items), active, updatedAt });
	}

	async function mutate(params: TodoParams): Promise<void> {
		const date = now();
		const result = apply(items, nextId, params, date);
		items = result.items;
		nextId = result.nextId;
		updatedAt = items.length ? date : undefined;
		await render(true);
	}

	async function settle(status: "completed" | "failed" | "canceled"): Promise<void> {
		if (items.length === 0) return;
		const date = now();
		items = items.map((item) => {
			if (item.status === "in_progress") return transition(item, status, date);
			if (status === "canceled" && item.status === "pending") return transition(item, "canceled", date);
			return item;
		});
		updatedAt = date;
		await render(false);
	}

	return {
		reset() {
			items = [];
			nextId = 1;
			updatedAt = undefined;
		},
		extension(pi) {
			pi.registerTool({
				name: "todo",
				label: "Todo",
				description: "Manage the visible task list for the current chat task.",
				promptSnippet: "Track substantial multi-step work with todo.",
				promptGuidelines: [
					"Use todo for substantial work with multiple meaningful steps. Skip it for trivial questions.",
					"Prefer action:'plan' once at the start, then update individual tasks by id.",
					"Start a task before working on it. Complete, fail, or cancel it as soon as that outcome is known.",
					"Keep task text short and outcome-focused.",
				],
				parameters: todoParameters,
				async execute(_toolCallId, params, signal) {
					signal?.throwIfAborted?.();
					await mutate(params as TodoParams);
					return {
						content: [{ type: "text", text: "Todo updated." }],
						details: { count: items.length },
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

export function createTodoExtension(options: TodoExtensionOptions): ExtensionFactory {
	return createTodoController(options).extension;
}

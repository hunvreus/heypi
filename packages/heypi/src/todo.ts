import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "@sinclair/typebox";

export type TodoStatus = "pending" | "in_progress" | "completed" | "failed" | "canceled";

export type TodoItem = {
	text: string;
	status: TodoStatus;
};

export type TodoConfig = {
	enabled?: boolean;
};

export type TodoUpdate = {
	items: TodoItem[];
	note?: string;
};

export type TodoExtensionOptions = {
	send(update: TodoUpdate): Promise<void>;
};

const TODO_SYMBOLS: Record<TodoStatus, string> = {
	pending: "○",
	in_progress: "●",
	completed: "✓",
	failed: "✕",
	canceled: "⊘",
};

const todoParameters = Type.Object({
	items: Type.Array(
		Type.Object({
			text: Type.String({ minLength: 1 }),
			status: Type.Union([
				Type.Literal("pending"),
				Type.Literal("in_progress"),
				Type.Literal("completed"),
				Type.Literal("failed"),
				Type.Literal("canceled"),
			]),
		}),
		{ minItems: 1 },
	),
	note: Type.Optional(Type.String()),
});

type TodoParams = Static<typeof todoParameters>;

export function renderTodo(update: TodoUpdate): string {
	const lines = update.items.map((item) => `${TODO_SYMBOLS[item.status]} ${item.text}`);
	if (update.note?.trim()) lines.push("", update.note.trim());
	return lines.join("\n");
}

export function createTodoExtension(options: TodoExtensionOptions): ExtensionFactory {
	return (pi) => {
		pi.registerTool({
			name: "todo_update",
			label: "Todo Update",
			description: "Replace the visible task list for the current chat task.",
			promptSnippet: "Maintain a concise visible task list for substantial multi-step work.",
			promptGuidelines: [
				"Use todo_update for substantial work with multiple meaningful steps. Skip it for trivial questions.",
				"Send the full current task list each time. Keep items short and outcome-focused.",
				"Use exactly one in_progress item while actively working. Mark items completed, failed, or canceled as soon as that status is known.",
				"On final completion, send a final list with no in_progress or pending items.",
			],
			parameters: todoParameters,
			async execute(_toolCallId, params, signal) {
				signal?.throwIfAborted?.();
				const update = params as TodoParams;
				await options.send(update);
				return {
					content: [{ type: "text", text: "Todo updated." }],
					details: { count: update.items.length },
				};
			},
		});
	};
}

import { describe, expect, it } from "vitest";
import { createTodoController, createTodoExtension, renderTodo } from "../src/todo.js";

type Tool = {
	name: string;
	execute(toolCallId: string, params: unknown, signal?: AbortSignal): Promise<unknown>;
};

type Handler = (event: never, context: never) => void | Promise<void>;

function piHarness(branch: unknown[] = []) {
	let tool: Tool | undefined;
	const handlers = new Map<string, Handler>();
	const entries: Array<{ customType: string; data: unknown }> = [];
	const messages: Array<{ message: unknown; options: unknown }> = [];
	return {
		api: {
			registerTool(next: Tool) {
				tool = next;
			},
			on(event: string, handler: Handler) {
				handlers.set(event, handler);
			},
			appendEntry(customType: string, data: unknown) {
				entries.push({ customType, data });
			},
			sendMessage(message: unknown, options: unknown) {
				messages.push({ message, options });
			},
		},
		get tool() {
			return tool;
		},
		handlers,
		entries,
		messages,
		context: { sessionManager: { getBranch: () => branch } },
	};
}

describe("todo", () => {
	const updatedAt = new Date(2026, 6, 8, 10, 15);

	it("renders compact task status lines with an active timestamp row", () => {
		expect(
			renderTodo(
				{
					active: true,
					updatedAt,
					items: [
						{ id: "inspect", text: "Inspect repo", status: "completed", updatedAt },
						{ id: "patch", text: "Patch bug", status: "in_progress", updatedAt },
						{ id: "pr", text: "Open PR", status: "pending", updatedAt },
						{ id: "deploy", text: "Run deploy", status: "failed", updatedAt },
						{ id: "old", text: "Old attempt", status: "canceled", updatedAt },
						{ id: "unknown", text: "Unreported result", status: "unknown", updatedAt },
					],
				},
				updatedAt,
			),
		).toBe(
			[
				"✓ Inspect repo",
				"● Patch bug",
				"○ Open PR",
				"✕ Run deploy",
				"⊘ Old attempt",
				"? Unreported result",
				"",
				"Last updated 10:15 (just now)",
			].join("\n"),
		);
	});

	it("normalizes full-list updates and advances the active task", async () => {
		const sent: string[] = [];
		const extension = createTodoExtension({
			now: () => updatedAt,
			async render(update) {
				sent.push(renderTodo(update, updatedAt));
			},
		});
		const harness = piHarness();
		extension(harness.api as never);

		expect(harness.tool?.name).toBe("todo");
		const first = await harness.tool?.execute("call", {
			items: [
				{ id: "inspect", text: "Inspect repo", status: "pending" },
				{ id: "patch", text: "Patch bug", status: "pending" },
			],
		});
		const second = await harness.tool?.execute("call", {
			items: [
				{ id: "inspect", text: "Inspect repo", status: "completed" },
				{ id: "patch", text: "Patch bug", status: "pending" },
			],
		});

		expect(first).toMatchObject({ details: { version: 1 } });
		expect(second).toMatchObject({ details: { version: 1 } });
		expect(sent).toEqual([
			["● Inspect repo", "○ Patch bug", "", "Last updated 10:15 (just now)"].join("\n"),
			["✓ Inspect repo", "● Patch bug", "", "Last updated 10:15 (just now)"].join("\n"),
		]);
		expect(harness.entries).toHaveLength(2);
	});

	it("rejects multiple active tasks and terminal regressions", async () => {
		const extension = createTodoExtension({ async render() {} });
		const harness = piHarness();
		extension(harness.api as never);

		await expect(
			harness.tool?.execute("call", {
				items: [
					{ id: "one", text: "One", status: "in_progress" },
					{ id: "two", text: "Two", status: "in_progress" },
				],
			}),
		).rejects.toThrow("Only one todo item may be in progress");

		await harness.tool?.execute("call", {
			items: [{ id: "one", text: "One", status: "completed" }],
		});
		await expect(
			harness.tool?.execute("call", {
				items: [{ id: "one", text: "One", status: "pending" }],
			}),
		).rejects.toThrow("cannot move from completed to pending");
	});

	it("requests one hidden reconciliation continuation for unresolved tasks", async () => {
		const extension = createTodoExtension({ async render() {} });
		const harness = piHarness();
		extension(harness.api as never);
		await harness.tool?.execute("call", {
			items: [
				{ id: "inspect", text: "Inspect repo", status: "pending" },
				{ id: "patch", text: "Patch bug", status: "pending" },
			],
		});
		const agentEnd = harness.handlers.get("agent_end");
		await agentEnd?.({ messages: [{ role: "assistant", stopReason: "stop" }] } as never, {} as never);
		await agentEnd?.({ messages: [{ role: "assistant", stopReason: "stop" }] } as never, {} as never);

		expect(harness.messages).toHaveLength(1);
		expect(harness.messages[0]).toMatchObject({
			message: { customType: "heypi.todo.reconcile", display: false },
			options: { triggerTurn: true, deliverAs: "followUp" },
		});
	});

	it("restores the latest todo snapshot from the Pi session branch", async () => {
		const snapshot = {
			version: 1,
			items: [{ id: "inspect", text: "Inspect repo", status: "in_progress", updatedAt: updatedAt.toISOString() }],
			updatedAt: updatedAt.toISOString(),
		};
		const branch = [
			{ type: "custom", customType: "heypi.todo", data: snapshot },
			{ type: "custom", customType: "other", data: {} },
		];
		const sent: string[] = [];
		const controller = createTodoController({
			now: () => updatedAt,
			async render(update) {
				sent.push(renderTodo(update, updatedAt));
			},
		});
		const harness = piHarness(branch);
		controller.extension(harness.api as never);
		await harness.handlers.get("session_start")?.({} as never, harness.context as never);
		await controller.cancel();

		expect(sent.at(-1)).toBe("⊘ Inspect repo");
	});

	it("settles unresolved tasks honestly when reconciliation is missed", async () => {
		const sent: string[] = [];
		const controller = createTodoController({
			now: () => updatedAt,
			async render(update) {
				sent.push(renderTodo(update, updatedAt));
			},
		});
		const harness = piHarness();
		controller.extension(harness.api as never);
		await harness.tool?.execute("call", {
			items: [
				{ id: "inspect", text: "Inspect repo", status: "pending" },
				{ id: "patch", text: "Patch bug", status: "pending" },
			],
		});
		await controller.complete();

		expect(sent.at(-1)).toBe(["? Inspect repo", "? Patch bug"].join("\n"));
	});

	it("fails the active task and leaves future outcomes unknown on errors", async () => {
		const sent: string[] = [];
		const controller = createTodoController({
			now: () => updatedAt,
			async render(update) {
				sent.push(renderTodo(update, updatedAt));
			},
		});
		const harness = piHarness();
		controller.extension(harness.api as never);
		await harness.tool?.execute("call", {
			items: [
				{ id: "inspect", text: "Inspect repo", status: "pending" },
				{ id: "patch", text: "Patch bug", status: "pending" },
			],
		});
		await controller.fail();

		expect(sent.at(-1)).toBe(["✕ Inspect repo", "? Patch bug"].join("\n"));
	});

	it("cancels pending and active todos on cancellation", async () => {
		const sent: string[] = [];
		const controller = createTodoController({
			now: () => updatedAt,
			async render(update) {
				sent.push(renderTodo(update, updatedAt));
			},
		});
		const harness = piHarness();
		controller.extension(harness.api as never);
		await harness.tool?.execute("call", {
			items: [
				{ id: "inspect", text: "Inspect repo", status: "pending" },
				{ id: "patch", text: "Patch bug", status: "pending" },
			],
		});
		await controller.cancel();

		expect(sent.at(-1)).toBe(["⊘ Inspect repo", "⊘ Patch bug"].join("\n"));
	});
});

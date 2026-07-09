import { describe, expect, it } from "vitest";
import { createTodoController, createTodoExtension, renderTodo } from "../src/todo.js";

describe("todo", () => {
	const updatedAt = new Date(2026, 6, 8, 10, 15);

	it("renders compact task status lines with an active timestamp row", () => {
		expect(
			renderTodo(
				{
					active: true,
					updatedAt,
					items: [
						{ id: 1, text: "Inspect repo", status: "completed", updatedAt },
						{ id: 2, text: "Patch bug", status: "in_progress", updatedAt },
						{ id: 3, text: "Open PR", status: "pending", updatedAt },
						{ id: 4, text: "Run deploy", status: "failed", updatedAt },
						{ id: 5, text: "Old attempt", status: "canceled", updatedAt },
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
				"",
				"Last updated 10:15 (just now)",
			].join("\n"),
		);
	});

	it("registers a Pi todo tool that mutates state by action", async () => {
		type Tool = {
			name: string;
			execute(toolCallId: string, params: unknown, signal?: AbortSignal): Promise<unknown>;
		};
		let tool: Tool | undefined;
		const sent: string[] = [];
		const extension = createTodoExtension({
			now: () => updatedAt,
			async render(update) {
				sent.push(renderTodo(update, updatedAt));
			},
		});

		extension({
			registerTool(next: Tool) {
				tool = next;
			},
		} as never);

		expect(tool?.name).toBe("todo");
		await expect(
			tool?.execute("call", { action: "plan", items: ["Inspect repo", "Patch bug"], start: 1 }),
		).resolves.toMatchObject({ details: { count: 2 } });
		await tool?.execute("call", { action: "complete", id: 1 });
		await tool?.execute("call", { action: "start", id: 2 });

		expect(sent).toEqual([
			["● Inspect repo", "○ Patch bug", "", "Last updated 10:15 (just now)"].join("\n"),
			["✓ Inspect repo", "○ Patch bug", "", "Last updated 10:15 (just now)"].join("\n"),
			["✓ Inspect repo", "● Patch bug", "", "Last updated 10:15 (just now)"].join("\n"),
		]);
	});

	it("settles active todos on completion without the timestamp row", async () => {
		type Tool = {
			execute(toolCallId: string, params: unknown, signal?: AbortSignal): Promise<unknown>;
		};
		let tool: Tool | undefined;
		const sent: string[] = [];
		const controller = createTodoController({
			now: () => updatedAt,
			async render(update) {
				sent.push(renderTodo(update, updatedAt));
			},
		});

		controller.extension({
			registerTool(next: Tool) {
				tool = next;
			},
		} as never);

		await tool?.execute("call", { action: "plan", items: ["Inspect repo", "Patch bug"], start: 1 });
		await controller.complete();

		expect(sent.at(-1)).toBe(["✓ Inspect repo", "○ Patch bug"].join("\n"));
	});

	it("cancels pending and active todos on cancellation", async () => {
		type Tool = {
			execute(toolCallId: string, params: unknown, signal?: AbortSignal): Promise<unknown>;
		};
		let tool: Tool | undefined;
		const sent: string[] = [];
		const controller = createTodoController({
			now: () => updatedAt,
			async render(update) {
				sent.push(renderTodo(update, updatedAt));
			},
		});

		controller.extension({
			registerTool(next: Tool) {
				tool = next;
			},
		} as never);

		await tool?.execute("call", { action: "plan", items: ["Inspect repo", "Patch bug"], start: 1 });
		await controller.cancel();

		expect(sent.at(-1)).toBe(["⊘ Inspect repo", "⊘ Patch bug"].join("\n"));
	});
});

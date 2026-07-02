import { describe, expect, it } from "vitest";
import { createTodoExtension, renderTodo } from "../src/todo.js";

describe("todo", () => {
	it("renders compact task status lines", () => {
		expect(
			renderTodo({
				items: [
					{ text: "Inspect repo", status: "completed" },
					{ text: "Patch bug", status: "in_progress" },
					{ text: "Open PR", status: "pending" },
					{ text: "Run deploy", status: "failed" },
					{ text: "Old attempt", status: "canceled" },
				],
				note: "Working in the current thread.",
			}),
		).toBe(
			[
				"✓ Inspect repo",
				"● Patch bug",
				"○ Open PR",
				"✕ Run deploy",
				"⊘ Old attempt",
				"",
				"Working in the current thread.",
			].join("\n"),
		);
	});

	it("registers a Pi todo_update tool and sends rendered updates", async () => {
		type Tool = {
			name: string;
			execute(toolCallId: string, params: unknown, signal?: AbortSignal): Promise<unknown>;
		};
		let tool: Tool | undefined;
		const sent: string[] = [];
		const extension = createTodoExtension({
			async send(update) {
				sent.push(renderTodo(update));
			},
		});

		extension({
			registerTool(next: Tool) {
				tool = next;
			},
		} as never);

		expect(tool?.name).toBe("todo_update");
		await expect(
			tool?.execute("call", { items: [{ text: "Ship slice", status: "completed" }] }),
		).resolves.toMatchObject({ details: { count: 1 } });
		expect(sent).toEqual(["✓ Ship slice"]);
	});
});

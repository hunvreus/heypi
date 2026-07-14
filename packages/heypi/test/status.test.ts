import { describe, expect, it } from "vitest";
import { createStatusSlot } from "../src/status.js";
import type { Adapter, ChatMessage, SendMessage } from "../src/types.js";

const message: ChatMessage = {
	id: "m1",
	adapter: "test",
	adapterId: "test",
	conversation: "room",
	user: { id: "u1" },
	text: "work",
	mentioned: true,
	dm: false,
};

describe("status slots", () => {
	it("keeps transient activity independent from persistent todo rendering", async () => {
		const sent = new Map<string, SendMessage>();
		const removed: string[] = [];
		let nextId = 1;
		const adapter: Adapter = {
			kind: "test",
			id: "test",
			progress: true,
			start() {},
			async send(outbound) {
				const id = String(nextId++);
				sent.set(id, outbound);
				return { id };
			},
			async update(update) {
				sent.set(update.id, update);
			},
			async remove(target) {
				removed.push(target.id);
				sent.delete(target.id);
			},
		};
		const activity = createStatusSlot({ adapter, message });
		const todo = createStatusSlot({ adapter, message });

		activity.replace("Thinking...");
		todo.replace("● Inspect\n○ Patch");
		activity.replace("Working...");
		await activity.clear();
		await todo.wait();

		expect(removed).toEqual(["1"]);
		expect([...sent.values()]).toEqual([{ conversation: "room", thread: undefined, text: "● Inspect\n○ Patch" }]);
	});
});

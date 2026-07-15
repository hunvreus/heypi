import { describe, expect, it } from "vitest";
import { createMessageSlot } from "../src/message-slot.js";
import type { Adapter, SendMessage } from "../src/types.js";

describe("message slots", () => {
	it("maintains one editable message", async () => {
		const sent = new Map<string, SendMessage>();
		const adapter: Adapter = {
			kind: "test",
			start() {},
			async send(message) {
				sent.set("1", message);
				return { id: "1" };
			},
			async update(message) {
				sent.set(message.id, message);
			},
		};
		const slot = createMessageSlot({ adapter, target: { conversation: "room", thread: "thread" } });

		await slot.replace("● Inspect\n○ Patch");
		await slot.replace("✓ Inspect\n● Patch");

		expect([...sent.values()]).toEqual([
			{ conversation: "room", thread: "thread", id: "1", text: "✓ Inspect\n● Patch" },
		]);
	});

	it("stays silent when message updates are unsupported", async () => {
		const sent: SendMessage[] = [];
		const adapter: Adapter = {
			kind: "test",
			start() {},
			async send(message) {
				sent.push(message);
				return { id: "1" };
			},
		};

		await createMessageSlot({ adapter, target: { conversation: "room" } }).replace("○ Inspect");

		expect(sent).toEqual([]);
	});

	it("reports created message ids without replacing adapter delivery", async () => {
		const observed: unknown[] = [];
		const adapter: Adapter = {
			kind: "test",
			start() {},
			async send() {
				return { id: "1", ids: ["1", "2"] };
			},
			async update() {},
		};
		const slot = createMessageSlot({
			adapter,
			target: { conversation: "room" },
			async onSent(sent) {
				observed.push(sent);
			},
		});

		await slot.replace("○ Inspect");

		expect(observed).toEqual([{ id: "1", ids: ["1", "2"] }]);
	});
});

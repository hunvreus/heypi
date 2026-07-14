import { describe, expect, it } from "vitest";
import { local } from "../src/adapters.js";
import type { ChatMessage } from "../src/types.js";

describe("local", () => {
	it("defaults inbound messages to direct trigger messages", async () => {
		const received: ChatMessage[] = [];
		const adapter = local();
		await adapter.start({
			agentId: "agent",
			logger: { debug() {}, info() {}, warn() {}, error() {} },
			async receive(message) {
				received.push(message);
			},
		});

		await adapter.receive({
			id: "m1",
			user: { id: "u1" },
			text: "hello",
		});

		expect(received).toEqual([
			{
				id: "m1",
				adapter: "local",
				adapterId: "local",
				conversation: "local",
				thread: undefined,
				user: { id: "u1" },
				text: "hello",
				mentioned: true,
				dm: true,
			},
		]);
	});

	it("preserves explicit thread ids", async () => {
		const received: ChatMessage[] = [];
		const adapter = local();
		await adapter.start({
			agentId: "agent",
			logger: { debug() {}, info() {}, warn() {}, error() {} },
			async receive(message) {
				received.push(message);
			},
		});

		await adapter.receive({
			id: "m1",
			thread: "root",
			user: { id: "u1" },
			text: "hello",
		});

		expect(received[0]?.thread).toBe("root");
	});
});

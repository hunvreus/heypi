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
				account: "local",
				conversation: "local",
				user: { id: "u1" },
				text: "hello",
				mentioned: true,
				dm: true,
			},
		]);
	});
});

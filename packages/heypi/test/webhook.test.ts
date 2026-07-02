import { describe, expect, it } from "vitest";
import { webhook } from "../src/adapters.js";
import type { ChatMessage } from "../src/types.js";

function freePort(): number {
	return 20_000 + Math.floor(Math.random() * 20_000);
}

describe("webhook", () => {
	it("accepts inbound HTTP messages", async () => {
		const received: ChatMessage[] = [];
		const adapter = webhook({ port: freePort() });
		await adapter.start({
			agentId: "agent",
			logger: { debug() {}, info() {}, warn() {}, error() {} },
			async receive(message) {
				received.push(message);
			},
		});
		try {
			const response = await fetch(adapter.url(), {
				method: "POST",
				body: JSON.stringify({
					id: "m1",
					account: "acct",
					conversation: "room",
					user: { id: "u1", name: "Ronan" },
					text: "hello",
				}),
			});
			await response.json();

			expect(response.status).toBe(202);
			expect(received).toEqual([
				{
					id: "m1",
					adapter: "webhook",
					account: "acct",
					conversation: "room",
					user: { id: "u1", name: "Ronan", isBot: false },
					text: "hello",
					mentioned: true,
					dm: false,
				},
			]);
		} finally {
			await adapter.stop?.();
		}
	});

	it("records outbound replies", async () => {
		const adapter = webhook({ port: freePort() });
		await adapter.send({ conversation: "room", text: "reply" });
		expect(adapter.sent).toEqual([{ conversation: "room", text: "reply" }]);
	});
});

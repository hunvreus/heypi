import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { webhook } from "../src/adapters.js";
import type { AdapterContext, ChatMessage } from "../src/types.js";

function freePort(): number {
	return 20_000 + Math.floor(Math.random() * 20_000);
}

function context(messages: ChatMessage[] = []): AdapterContext {
	return {
		agentId: "agent",
		logger: {
			debug() {},
			info() {},
			warn() {},
			error() {},
		},
		async receive(message) {
			messages.push(message);
		},
	};
}

function signature(secret: string, timestamp: string, rawBody: string): string {
	return `sha256=${createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex")}`;
}

describe("webhook", () => {
	it("accepts signed messages when a secret is configured", async () => {
		const messages: ChatMessage[] = [];
		const adapter = webhook({ port: freePort(), secret: "secret" });
		await adapter.start(context(messages));
		try {
			const raw = JSON.stringify({ id: "m1", text: "hello", user: { id: "u1" } });
			const timestamp = String(Math.floor(Date.now() / 1000));
			const response = await fetch(adapter.url(), {
				method: "POST",
				headers: {
					"content-type": "application/json",
					"x-heypi-timestamp": timestamp,
					"x-heypi-signature": signature("secret", timestamp, raw),
				},
				body: raw,
			});

			expect(response.status).toBe(202);
			expect(messages).toMatchObject([{ id: "m1", text: "hello", user: { id: "u1" } }]);
		} finally {
			await adapter.stop?.();
		}
	});

	it("rejects unsigned messages when a secret is configured", async () => {
		const adapter = webhook({ port: freePort(), secret: "secret" });
		await adapter.start(context());
		try {
			const response = await fetch(adapter.url(), {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ id: "m1", text: "hello", user: { id: "u1" } }),
			});

			expect(response.status).toBe(401);
		} finally {
			await adapter.stop?.();
		}
	});

	it("requires a secret for non-loopback hosts", async () => {
		const adapter = webhook({ host: "0.0.0.0", port: freePort() });

		await expect(adapter.start(context())).rejects.toThrow("Webhook secret is required");
	});
});

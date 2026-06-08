import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

// Verifies the workerd-resident orchestration layer: Worker routing + the ThreadAgent Durable
// Object + DO-SQLite session persistence. The DO is Pi-free (Pi runs in a container), so this
// exercises the lock/state/routing infrastructure that actually lives in the isolate.

async function turn(threadKey: string, sessionId: string, text: string): Promise<{ reply: string; entries: number }> {
	const res = await SELF.fetch("https://heypi.test/turn", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ threadKey, sessionId, text }),
	});
	expect(res.status).toBe(200);
	return (await res.json()) as { reply: string; entries: number };
}

describe("ThreadAgent worker", () => {
	it("persists session state in DO SQLite across requests", async () => {
		const first = await turn("T1", "S1", "deploy staging");
		expect(first.reply).toBe("ack: deploy staging");
		expect(first.entries).toBe(2);

		// A second request to the same thread proves the DO persisted turn 1 in its SQLite and
		// loaded it back — entirely inside workerd, no external database, no filesystem.
		const second = await turn("T1", "S1", "status?");
		expect(second.entries).toBe(4);
	});

	it("routes different thread keys to isolated Durable Objects", async () => {
		const a = await turn("A", "SA", "hi");
		const b = await turn("B", "SB", "hi");
		expect(a.entries).toBe(2);
		expect(b.entries).toBe(2);
	});

	it("rejects malformed requests", async () => {
		const res = await SELF.fetch("https://heypi.test/turn", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ threadKey: "T" }),
		});
		expect(res.status).toBe(400);
	});
});

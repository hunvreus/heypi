import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import type { SessionEntry } from "@hunvreus/heypi/runtime";
import { ContainerRunner, EchoRunner } from "../src/runner.js";

const realFetch = globalThis.fetch;
afterEach(() => {
	globalThis.fetch = realFetch;
});

test("EchoRunner appends a linked user/assistant pair", async () => {
	const first = await new EchoRunner().run({ sessionId: "s1", entries: [], text: "hi" });
	assert.equal(first.reply, "ack: hi");
	assert.equal(first.entries.length, 2);
	const second = await new EchoRunner().run({ sessionId: "s1", entries: first.entries, text: "again" });
	assert.equal(second.entries.length, 4);
	assert.equal(second.entries[2].parentId, first.entries[1].id, "new entries chain onto the prior transcript");
});

test("ContainerRunner posts the transcript to the runner and returns its result", async () => {
	let captured: { url: string; body: unknown } | undefined;
	const returned = {
		reply: "pong",
		entries: [{ type: "message", id: "x", parentId: null }] as unknown as SessionEntry[],
	};
	globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
		captured = { url: String(input), body: JSON.parse(String(init?.body)) };
		return new Response(JSON.stringify(returned), { status: 200, headers: { "content-type": "application/json" } });
	}) as typeof fetch;

	const result = await new ContainerRunner("http://runner.local").run({ sessionId: "s1", entries: [], text: "ping" });

	assert.equal(captured?.url, "http://runner.local/run");
	assert.deepEqual(captured?.body, { sessionId: "s1", entries: [], text: "ping" });
	assert.deepEqual(result, returned);
});

test("ContainerRunner throws on a non-2xx runner response", async () => {
	globalThis.fetch = (async () => new Response("boom", { status: 500 })) as typeof fetch;
	await assert.rejects(
		() => new ContainerRunner("http://runner.local").run({ sessionId: "s1", entries: [], text: "ping" }),
		/runner responded 500/,
	);
});

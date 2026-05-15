import assert from "node:assert/strict";
import { test } from "node:test";
import { DraftReplyStream, type ReplyStreamTransport } from "../src/io/reply-stream.js";

test("DraftReplyStream creates once and edits throttled text", async () => {
	const calls: string[] = [];
	const transport: ReplyStreamTransport = {
		limit: 100,
		create: async (text) => {
			calls.push(`create:${text}`);
			return "m1";
		},
		edit: async (_id, text) => {
			calls.push(`edit:${text}`);
		},
	};
	const stream = new DraftReplyStream(transport, { intervalMs: 1000, minChars: 5 });

	await stream.update("hello");
	await stream.update("hello world");
	await stream.finalize("hello world!");

	assert.deepEqual(calls, ["create:hello", "edit:hello world!"]);
	assert.equal(stream.sent(), true);
	assert.equal(stream.complete(), true);
});

test("DraftReplyStream stops after repeated transport failures", async () => {
	let attempts = 0;
	const transport: ReplyStreamTransport = {
		limit: 100,
		create: async () => {
			attempts++;
			throw new Error("rate limited");
		},
		edit: async () => undefined,
	};
	const stream = new DraftReplyStream(transport, { intervalMs: 1, minChars: 1, maxFailures: 1 });

	await stream.update("hello");
	await stream.finalize("hello world");

	assert.equal(attempts, 1);
	assert.equal(stream.sent(), false);
	assert.equal(stream.complete(), false);
});

test("DraftReplyStream reports incomplete when final edit fails", async () => {
	const transport: ReplyStreamTransport = {
		limit: 100,
		create: async () => "m1",
		edit: async () => {
			throw new Error("timeout");
		},
	};
	const stream = new DraftReplyStream(transport, { intervalMs: 1, minChars: 1 });

	await stream.update("hello");
	await stream.finalize("hello world");

	assert.equal(stream.sent(), true);
	assert.equal(stream.complete(), false);
});

test("DraftReplyStream clear is idempotent under concurrent calls", async () => {
	const deleted: string[] = [];
	const transport: ReplyStreamTransport = {
		limit: 100,
		create: async () => "m1",
		edit: async () => undefined,
		delete: async (id) => {
			deleted.push(id);
		},
	};
	const stream = new DraftReplyStream(transport, { intervalMs: 1, minChars: 1 });

	await stream.update("hello");
	await Promise.all([stream.clear(), stream.clear()]);

	assert.deepEqual(deleted, ["m1"]);
	assert.equal(stream.sent(), false);
});

import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveScope } from "../src/core/scope.js";
import { runChatMessage } from "../src/io/chat-message.js";
import type { Handler, Outbound } from "../src/io/handler.js";
import type { ReplyStream } from "../src/io/reply-stream.js";

test("runChatMessage loads attachments and dispatches fresh output", async () => {
	const calls: string[] = [];
	const stream = streamStub(calls, true);
	const progress = progressStub(calls);
	const handler: Handler = async (input) => {
		assert.equal(input.attachments?.[0]?.id, "a1");
		assert.equal(input.stream, stream);
		return { text: "done", finalPlacement: "thread" };
	};

	await runChatMessage({
		logger: loggerStub(),
		context: contextStub,
		handler,
		stream,
		progress,
		loadAttachments: async () => [{ id: "a1", name: "a.txt", path: "/tmp/a.txt" }],
		inbound: () => inbound(),
		placement: {
			fresh: async (out) => {
				calls.push(`fresh:${out.text}`);
			},
			streamed: async () => {
				calls.push("streamed");
			},
			progress: async () => {
				calls.push("progress");
			},
		},
		sendError: async () => {
			calls.push("error");
		},
	});

	assert.deepEqual(calls, ["progress.stop", "stream.clear", "fresh:done", "progress.stop"]);
});

test("runChatMessage loads attachments with the handler attachment scope", async () => {
	const keys = resolveScope({ agent: "agent", provider: "test", kind: "test", channel: "c", actor: "u" });
	const handler: Handler = async (input) => {
		assert.equal(input.attachments?.[0]?.scope, keys.channel.path);
		return { text: "done", finalPlacement: "thread" };
	};
	handler.attachmentScope = () => keys.channel;

	await runChatMessage({
		logger: loggerStub(),
		context: contextStub,
		handler,
		loadAttachments: async (scope) => [{ name: "a.txt", path: "/tmp/a.txt", scope: scope?.path }],
		inbound: () => inbound(),
		placement: placementStub([]),
		sendError: async () => undefined,
	});
});

test("runChatMessage sends private output through the private callback", async () => {
	const calls: string[] = [];
	await runChatMessage({
		logger: loggerStub(),
		context: contextStub,
		handler: async () => ({ text: "secret", private: true }),
		stream: streamStub(calls, false),
		progress: progressStub(calls),
		inbound: () => inbound(),
		sendPrivate: async (out) => {
			calls.push(`private:${out.text}`);
		},
		placement: placementStub(calls),
		sendError: async () => {
			calls.push("error");
		},
		afterSend: async (_out, visibility) => {
			calls.push(`sent:${visibility}`);
		},
	});

	assert.deepEqual(calls, ["stream.clear", "private:secret", "sent:private", "progress.stop"]);
});

test("runChatMessage logs errors, sends platform fallback, and stops progress", async () => {
	const calls: string[] = [];
	const errors: unknown[] = [];
	await runChatMessage({
		logger: { error: (_msg, fields) => errors.push(fields) },
		context: contextStub,
		handler: async () => {
			throw new Error("boom");
		},
		progress: progressStub(calls),
		inbound: () => inbound(),
		placement: placementStub(calls),
		sendError: async () => {
			calls.push("error");
		},
	});

	assert.deepEqual(calls, ["error", "progress.stop"]);
	assert.equal((errors[0] as { error: string }).error, "boom");
});

test("runChatMessage logs afterSend failures without sending a fallback reply", async () => {
	const calls: string[] = [];
	const errors: unknown[] = [];
	await runChatMessage({
		logger: { error: (_msg, fields) => errors.push(fields) },
		context: contextStub,
		handler: async () => ({ text: "done", finalPlacement: "thread" }),
		stream: streamStub(calls, true),
		progress: progressStub(calls),
		inbound: () => inbound(),
		placement: placementStub(calls),
		sendError: async () => {
			calls.push("error");
		},
		afterSend: async () => {
			throw new Error("upload failed");
		},
	});

	assert.deepEqual(calls, ["progress.stop", "stream.clear", "fresh:done", "progress.stop"]);
	assert.equal((errors[0] as { error: string }).error, "upload failed");
});

function inbound() {
	return {
		provider: "test",
		kind: "test",
		channel: "c",
		actor: "u",
		thread: "t",
		text: "hello",
	};
}

function streamStub(calls: string[], complete: boolean): ReplyStream {
	return {
		update: async () => undefined,
		finalize: async () => undefined,
		stop: async () => {
			calls.push("stream.stop");
		},
		clear: async () => {
			calls.push("stream.clear");
		},
		complete: () => complete,
	};
}

function progressStub(calls: string[]) {
	return {
		stop: async () => {
			calls.push("progress.stop");
		},
	};
}

function placementStub(calls: string[]) {
	return {
		fresh: async (out: Outbound) => {
			calls.push(`fresh:${out.text}`);
		},
		streamed: async (out: Outbound) => {
			calls.push(`streamed:${out.text}`);
		},
		progress: async (out: Outbound) => {
			calls.push(`progress:${out.text}`);
		},
	};
}

function loggerStub() {
	return { error: () => undefined };
}

function contextStub(extra?: Record<string, unknown>): Record<string, unknown> {
	return extra ?? {};
}

import assert from "node:assert/strict";
import { test } from "node:test";
import type { Logger } from "../src/core/log.js";
import type { AttachmentStore } from "../src/io/attachments.js";
import { DeliveryQueue } from "../src/io/delivery.js";
import type { Handler } from "../src/io/handler.js";
import { DraftReplyStream } from "../src/io/reply-stream.js";
import {
	handleAction,
	postSlackAttachmentUploadNotice,
	SlackGroupResolver,
	startProgress,
	uploadSlackAttachments,
} from "../src/io/slack.js";

const logger: Logger = {
	debug: () => undefined,
	info: () => undefined,
	warn: () => undefined,
	error: () => undefined,
};

test("Slack attachment upload reports failed uploads", async () => {
	const store: AttachmentStore = {
		async save() {
			throw new Error("unused");
		},
		async resolve() {
			return { path: "/tmp/report.html", name: "report.html", mimeType: "text/html", size: 42 };
		},
	};
	const client = {
		files: {
			uploadV2: async () => {
				throw new Error("missing_scope");
			},
		},
	} as unknown as Parameters<typeof uploadSlackAttachments>[0]["client"];

	const result = await uploadSlackAttachments({
		client,
		store,
		channel: "C1",
		thread: "1700000000.000000",
		attachments: [{ path: "report.html", name: "report.html", mimeType: "text/html" }],
		logger,
		context: { adapter: "slack" },
		delivery: new DeliveryQueue(false),
	});

	assert.deepEqual(result, { requested: 1, resolved: 1, uploaded: false });
});

test("Slack attachment upload failure is visible in the thread", async () => {
	const posted: unknown[] = [];
	const client = {
		chat: {
			postMessage: async (message: unknown) => {
				posted.push(message);
				return { ok: true };
			},
		},
	} as unknown as Parameters<typeof postSlackAttachmentUploadNotice>[0]["client"];

	await postSlackAttachmentUploadNotice({
		client,
		channel: "C1",
		thread: "1700000000.000000",
		upload: { requested: 1, resolved: 1, uploaded: false },
		logger,
		context: { adapter: "slack" },
		delivery: new DeliveryQueue(false),
	});

	assert.equal(posted.length, 1);
	assert.match(JSON.stringify(posted[0]), /Slack did not accept the upload/);
	assert.match(JSON.stringify(posted[0]), /files:write/);
});

test("Slack approval action uploads attachments from approved continuations", async () => {
	const posted: unknown[] = [];
	const uploaded: unknown[] = [];
	const store: AttachmentStore = {
		async save() {
			throw new Error("unused");
		},
		async resolve() {
			return { path: "/tmp/heypi.dev.html", name: "heypi.dev.html", mimeType: "text/html", size: 42 };
		},
	};
	const client = {
		chat: {
			postMessage: async (message: unknown) => {
				posted.push(message);
				return { ok: true, ts: "1700000000.000002" };
			},
		},
		files: {
			uploadV2: async (message: unknown) => {
				uploaded.push(message);
				return { ok: true };
			},
		},
	};
	const handler = (async () => ({
		text: "Attached: heypi.dev.html",
		attachments: [{ path: "heypi.dev.html", name: "heypi.dev.html", mimeType: "text/html" }],
	})) as Handler;

	await handleAction({
		kind: "approve",
		body: {
			team: { id: "T1" },
			channel: { id: "C1" },
			user: { id: "U1" },
			message: { ts: "1700000000.000001", thread_ts: "1700000000.000000" },
		},
		action: { value: "approval-1" },
		client: client as Parameters<typeof handleAction>[0]["client"],
		handler,
		logger,
		delivery: new DeliveryQueue(false),
		provider: "slack",
		adapterKind: "slack",
		groups: new SlackGroupResolver([], logger),
		progress: false,
		attachments: store,
	});

	assert.equal(posted.length, 1);
	assert.match(JSON.stringify(posted[0]), /Attached: heypi.dev.html/);
	assert.equal(uploaded.length, 1);
	assert.deepEqual(uploaded[0], {
		channel_id: "C1",
		thread_ts: "1700000000.000000",
		file_uploads: [{ file: "/tmp/heypi.dev.html", filename: "heypi.dev.html", title: "heypi.dev.html" }],
	});
});

test("Slack streaming adopts the progress message instead of deleting it", async () => {
	const calls: string[] = [];
	const client = {
		chat: {
			postMessage: async () => {
				calls.push("progress.post");
				return { ok: true, ts: "progress-1" };
			},
			update: async (message: { ts: string; text?: string; blocks?: unknown[] }) => {
				calls.push(`update:${message.ts}:${message.text}:${JSON.stringify(message.blocks)}`);
				return { ok: true };
			},
			delete: async (message: { ts: string }) => {
				calls.push(`delete:${message.ts}`);
				return { ok: true };
			},
		},
		reactions: {
			add: async () => ({ ok: true }),
			remove: async () => ({ ok: true }),
		},
	};
	const progress = startProgress({
		channel: "C1",
		target: "1700000000.000000",
		client: client as unknown as Parameters<typeof startProgress>[0]["client"],
		progress: { delayMs: 0 },
		cancelId: "trace-1",
		logger,
		context: { adapter: "slack" },
		delivery: new DeliveryQueue(false),
	});
	await waitFor(() => calls.includes("progress.post"));
	const stream = new DraftReplyStream(
		{
			limit: 100,
			create: async (text) => {
				const adopted = await progress.takeover();
				if (!adopted) throw new Error("expected progress message takeover");
				await client.chat.update({ ts: adopted, text, blocks: [] });
				return adopted;
			},
			edit: async (id, text) => {
				await client.chat.update({ ts: id, text, blocks: [] });
			},
			delete: async (id) => {
				await client.chat.delete({ ts: id });
			},
		},
		{ intervalMs: 1, minChars: 1 },
	);

	await stream.update("streaming");
	await stream.finalize("streaming done");

	assert.deepEqual(calls, ["progress.post", "update:progress-1:streaming:[]", "update:progress-1:streaming done:[]"]);
});

async function waitFor(fn: () => boolean): Promise<void> {
	const deadline = Date.now() + 500;
	while (!fn()) {
		if (Date.now() > deadline) throw new Error("Timed out waiting for Slack progress");
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}

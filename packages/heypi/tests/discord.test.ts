import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Message, TextBasedChannel } from "discord.js";
import { normalizeApprovalDetails } from "../src/core/approval-view.js";
import { consoleLogger, type Logger } from "../src/core/log.js";
import type { AttachmentStore } from "../src/io/attachments.js";
import { DeliveryQueue } from "../src/io/delivery.js";
import {
	approvalView,
	assertDiscordAttachmentUrl,
	discordAllowed,
	discordTriggered,
	sendDiscordOutput,
	startDiscordProgress,
} from "../src/io/discord.js";
import { DraftReplyStream } from "../src/io/reply-stream.js";

test("Discord allowlists default to accepting delivered messages", () => {
	assert.deepEqual(discordAllowed(undefined, { channel: "C1", user: "U1", isDm: false }), { ok: true });
});

test("Discord allowlists reject mismatched dimensions and disabled DMs", () => {
	assert.deepEqual(discordAllowed({ channels: ["C2"] }, { channel: "C1", user: "U1", isDm: false }), {
		ok: false,
		reason: "channel not allowed",
	});
	assert.deepEqual(discordAllowed({ users: ["U2"] }, { channel: "C1", user: "U1", isDm: false }), {
		ok: false,
		reason: "actor not allowed",
	});
	assert.deepEqual(discordAllowed({ groups: ["R1"] }, { channel: "C1", user: "U1", groups: ["R1"], isDm: false }), {
		ok: true,
	});
	assert.deepEqual(
		discordAllowed({ users: ["U2"], groups: ["R1"] }, { channel: "C1", user: "U1", groups: ["R1"], isDm: false }),
		{
			ok: true,
		},
	);
	assert.deepEqual(discordAllowed({ dms: false }, { channel: "D1", user: "U1", isDm: true }), {
		ok: false,
		reason: "dm disabled",
	});
	assert.deepEqual(discordAllowed({ channels: ["C1"], dms: true }, { channel: "D1", user: "U1", isDm: true }), {
		ok: true,
	});
});

test("Discord trigger defaults to mention for channels and message for DMs", () => {
	assert.deepEqual(discordTriggered(undefined, { text: "hello", isDm: false, mentioned: false }), {
		ok: false,
		reason: "mention required",
	});
	assert.deepEqual(discordTriggered(undefined, { text: "hello", isDm: false, mentioned: true }), { ok: true });
	assert.deepEqual(discordTriggered(undefined, { text: "/approve A1", isDm: false, mentioned: false }), { ok: true });
	assert.deepEqual(discordTriggered(undefined, { text: "hello", isDm: true, mentioned: false }), { ok: true });
	assert.deepEqual(discordTriggered("message", { text: "hello", isDm: false, mentioned: false }), { ok: true });
});

test("Discord attachment URLs are limited to Discord CDN hosts", () => {
	assert.doesNotThrow(() => assertDiscordAttachmentUrl("https://cdn.discordapp.com/attachments/1/2/file.txt"));
	assert.doesNotThrow(() => assertDiscordAttachmentUrl("https://media.discordapp.net/attachments/1/2/file.png"));
	assert.throws(() => assertDiscordAttachmentUrl("http://cdn.discordapp.com/attachments/1/2/file.txt"), /protocol/);
	assert.throws(() => assertDiscordAttachmentUrl("https://example.com/attachments/1/2/file.txt"), /host/);
});

test("Discord approval view presents pending and rejected states as card data", () => {
	const approval = {
		id: "approval-1",
		callId: "call-1",
		command: "curl --version",
		runtime: "just-bash",
		reason: "Run bash command.",
		allowed: [],
		requestedBy: "U_REQUESTER",
		details: [{ label: "Command", value: "curl --version", format: "code" as const }],
	};

	assert.deepEqual(approvalView({ approval, state: "pending" }), {
		title: "Approval required",
		color: 0xf59e0b,
		fields: [
			{ name: "Reason", value: "Run bash command." },
			{ name: "Command", value: "```\ncurl --version\n```" },
			{ name: "Approval ID", value: "approval-1" },
			{ name: "Requested by", value: "<@U_REQUESTER>" },
		],
	});

	const rejected = approvalView({ approval, state: "rejected", actor: "U1" });
	assert.equal(rejected.title, "Rejected");
	assert.equal(rejected.color, 0xef4444);
	assert.deepEqual(rejected.fields.at(-1), {
		name: "Rejected by",
		value: "<@U1>",
	});

	const approved = approvalView({ approval, state: "approved", actor: "U1" });
	assert.equal(approved.title, "Approved");
	assert.equal(approved.color, 0x22c55e);
	assert.deepEqual(approved.fields.at(-1), {
		name: "Approved by",
		value: "<@U1>",
	});

	const expired = approvalView({ approval, state: "expired" });
	assert.equal(expired.title, "Expired");
	assert.equal(expired.color, 0x64748b);
	assert.deepEqual(expired.fields.at(-1), {
		name: "Status",
		value: "Expired",
	});
});

test("Discord approval view truncates long code details inside a valid code fence", () => {
	const view = approvalView({
		state: "pending",
		approval: {
			id: "approval-1",
			callId: "call-1",
			command: "bash",
			runtime: "tool",
			reason: "Run command.",
			allowed: [],
			details: [{ label: "Command", value: "x".repeat(2000), format: "code" }],
		},
	});

	const command = view.fields.find((field) => field.name === "Command");
	assert.ok(command);
	assert.equal(command.value.startsWith("```\n"), true);
	assert.equal(command.value.endsWith("\n```"), true);
	assert.equal(command.value.length <= 1024, true);
});

test("approval details are capped to stay within Discord embed field limits", () => {
	const details = normalizeApprovalDetails(
		Array.from({ length: 40 }, (_, index) => ({
			label: `Detail ${index + 1}`,
			value: `value ${index + 1}`,
		})),
	);
	const view = approvalView({
		state: "rejected",
		actor: "U_REVIEWER",
		approval: {
			id: "approval-1",
			callId: "call-1",
			command: "tool",
			runtime: "tool",
			reason: "Review details.",
			allowed: [],
			requestedBy: "U_REQUESTER",
			details,
		},
	});

	assert.ok(view.fields.length <= 25);
	assert.deepEqual(view.fields.at(-2), { name: "Requested by", value: "<@U_REQUESTER>" });
	assert.deepEqual(view.fields.at(-3), { name: "Approval ID", value: "approval-1" });
	assert.deepEqual(view.fields.at(-4), { name: "Additional details", value: "20 omitted." });
});

test("Discord progress update waits for an in-flight placeholder send", async () => {
	const placeholder = discordPlaceholder();
	const reply = deferred<typeof placeholder.message>();
	const message = discordMessage(reply.promise, placeholder);
	await usingProgress(message, async (progress) => {
		await waitFor(() => placeholder.replyStarted);
		const updated = progress.update({ text: "done" });
		reply.resolve(placeholder.message);

		assert.equal(await updated, true);
		assert.deepEqual(placeholder.edits, [{ content: "done", embeds: [], components: [] }]);
		assert.deepEqual(placeholder.deletes, []);
	});
});

test("Discord progress stop deletes an in-flight placeholder send", async () => {
	const placeholder = discordPlaceholder();
	const reply = deferred<typeof placeholder.message>();
	const message = discordMessage(reply.promise, placeholder);
	await usingProgress(message, async (progress) => {
		await waitFor(() => placeholder.replyStarted);
		const stopped = progress.stop();
		reply.resolve(placeholder.message);

		await stopped;
		assert.deepEqual(placeholder.edits, []);
		assert.deepEqual(placeholder.deletes, ["progress-1"]);
	});
});

test("Discord streaming adopts the progress message instead of deleting it", async () => {
	const placeholder = discordPlaceholder();
	const message = discordMessage(Promise.resolve(placeholder.message), placeholder);
	await usingProgress(message, async (progress) => {
		await waitFor(() => placeholder.replyStarted);
		const stream = new DraftReplyStream(
			{
				limit: 100,
				create: async (text) => {
					const adopted = await progress.takeover();
					if (!adopted) throw new Error("expected progress message takeover");
					const sent = await message.channel.messages.fetch(adopted);
					await sent.edit({ content: text, embeds: [], components: [] });
					return adopted;
				},
				edit: async (id, text) => {
					const sent = await message.channel.messages.fetch(id);
					await sent.edit({ content: text, embeds: [], components: [] });
				},
				delete: async (id) => {
					const sent = await message.channel.messages.fetch(id);
					await sent.delete();
				},
			},
			{ intervalMs: 1, minChars: 1 },
		);

		await stream.update("streaming");
		await stream.finalize("streaming done");

		assert.deepEqual(placeholder.edits, [
			{ content: "streaming", embeds: [], components: [] },
			{ content: "streaming done", embeds: [], components: [] },
		]);
		assert.deepEqual(placeholder.deletes, []);
	});
});

test("Discord attachment upload failure is visible in the channel", async () => {
	const sent: unknown[] = [];
	const file = await testAttachmentFile();
	const channel = {
		send: async (payload: Record<string, unknown>) => {
			sent.push(payload);
			if (payload.files) throw new Error("missing permissions");
			return { id: `message-${sent.length}` };
		},
	} as unknown as TextBasedChannel;
	const store: AttachmentStore = {
		async save() {
			throw new Error("unused");
		},
		async resolve() {
			return { path: file.path, name: "report.html", mimeType: "text/html", size: 42 };
		},
	};

	try {
		await sendDiscordOutput({
			channel,
			store,
			out: {
				text: "Attached: report.html",
				attachments: [{ path: "report.html", name: "report.html", mimeType: "text/html" }],
			},
			logger: consoleLogger({ level: "error", format: "pretty" }),
			context: {},
			delivery: new DeliveryQueue(false),
		});

		assert.equal(sent.length, 3);
		assert.deepEqual(sent[0], { content: "Attached: report.html" });
		assert.match(JSON.stringify(sent[2]), /Discord did not accept the upload/);
	} finally {
		await file.cleanup();
	}
});

test("Discord ambiguous attachment upload aborts post an unconfirmed upload notice", async () => {
	const sent: unknown[] = [];
	const file = await testAttachmentFile();
	const channel = {
		send: async (payload: Record<string, unknown>) => {
			sent.push(payload);
			if (payload.files) throw new DOMException("This operation was aborted", "AbortError");
			return { id: `message-${sent.length}` };
		},
	} as unknown as TextBasedChannel;
	const store: AttachmentStore = {
		async save() {
			throw new Error("unused");
		},
		async resolve() {
			return { path: file.path, name: "report.html", mimeType: "text/html", size: 42 };
		},
	};

	try {
		await sendDiscordOutput({
			channel,
			store,
			out: {
				text: "Attached: report.html",
				attachments: [{ path: "report.html", name: "report.html", mimeType: "text/html" }],
			},
			logger: consoleLogger({ level: "error", format: "pretty" }),
			context: {},
			delivery: new DeliveryQueue(false),
		});

		assert.equal(sent.length, 3);
		assert.deepEqual(sent[0], { content: "Attached: report.html" });
		assert.deepEqual(Object.keys(sent[1] as Record<string, unknown>).sort(), ["content", "files"]);
		assert.equal((sent[1] as Record<string, unknown>).content, "Attached: report.html");
		assert.match(JSON.stringify(sent[2]), /Discord did not confirm the upload/);
	} finally {
		await file.cleanup();
	}
});

function discordPlaceholder() {
	const edits: unknown[] = [];
	const deletes: string[] = [];
	return {
		edits,
		deletes,
		replyStarted: false,
		message: {
			id: "progress-1",
			edit: async (payload: unknown) => {
				edits.push(payload);
			},
			delete: async () => {
				deletes.push("progress-1");
			},
		},
	};
}

function discordMessage(reply: Promise<{ id: string }>, placeholder: ReturnType<typeof discordPlaceholder>): Message {
	return {
		reply: async () => {
			placeholder.replyStarted = true;
			return await reply;
		},
		channel: {
			messages: {
				fetch: async () => placeholder.message,
			},
		},
	} as unknown as Message;
}

async function usingProgress(
	message: Message,
	fn: (progress: ReturnType<typeof startDiscordProgress>) => Promise<void>,
): Promise<void> {
	const progress = startDiscordProgress({
		message,
		progress: { delayMs: 0 },
		logger: consoleLogger({ level: "error", format: "pretty" }) satisfies Logger,
		context: {},
		delivery: new DeliveryQueue(false),
	});
	await fn(progress);
	await progress.stop();
}

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

async function waitFor(done: () => boolean): Promise<void> {
	const deadline = Date.now() + 1000;
	while (!done()) {
		if (Date.now() > deadline) throw new Error("Timed out waiting for Discord progress");
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

async function testAttachmentFile(): Promise<{ path: string; cleanup(): Promise<void> }> {
	const dir = await mkdtemp(join(tmpdir(), "heypi-discord-upload-"));
	const path = join(dir, "report.html");
	await writeFile(path, "<html>report</html>", "utf8");
	return {
		path,
		cleanup: () => rm(dir, { recursive: true, force: true }),
	};
}

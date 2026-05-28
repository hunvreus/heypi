import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, realpath, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { resolveScope } from "../src/core/scope.js";
import { resolveOutboundAttachments, saveInboundAttachments } from "../src/io/attachment-policy.js";
import type { AttachmentStore, ResolvedAttachment } from "../src/io/attachments.js";
import { attachmentInput, attachmentPrompt, responseBytes, runtimeAttachments } from "../src/io/attachments.js";
import type { Runtime } from "../src/runtime/types.js";

test("attachmentPrompt appends stable paths and metadata", () => {
	assert.equal(
		attachmentPrompt("review this", [
			{ name: "report.txt", path: "/incoming/report.txt", mimeType: "text/plain", size: 5 },
		]),
		"review this\nAttachments:\n- report.txt: /incoming/report.txt (text/plain, 5 bytes)",
	);
});

test("runtimeAttachments scopes inbound attachment access", async () => {
	const root = await mkdtemp(join(tmpdir(), "heypi-attachments-scoped-"));
	const store = runtimeAttachments(runtime(root, "just-bash"));
	const keys = resolveScope({
		agent: "agent",
		provider: "slack",
		kind: "slack",
		team: "T1",
		channel: "C1",
		actor: "U1",
	});
	const other = resolveScope({
		agent: "agent",
		provider: "slack",
		kind: "slack",
		team: "T1",
		channel: "C2",
		actor: "U2",
	});

	const file = await store.save({
		provider: "slack",
		id: "F123",
		name: "hello.txt",
		data: new TextEncoder().encode("hello"),
		mimeType: "text/plain",
		messageId: "1700.1",
		scope: keys.channel,
	});

	assert.equal(file.scope, keys.channel.path);
	assert.equal(file.path, "/attachments/scopes/channel/agent/slack/T1/C1/incoming/slack/1700.1/F123-hello.txt");
	assert.equal((await store.resolve(file, keys.channel)).size, 5);
	await assert.rejects(() => store.resolve(file, other.channel), /scope mismatch/);
	await mkdir(join(root, "scopes", keys.channel.path), { recursive: true });
	await writeFile(join(root, "scopes", keys.channel.path, "report.txt"), "report");
	assert.equal((await store.resolve({ path: `/scopes/${keys.channel.path}/report.txt` }, keys.channel)).size, 6);
	await assert.rejects(
		() => store.resolve({ path: `/scopes/${keys.channel.path}/report.txt` }, other.channel),
		/scope mismatch/,
	);
	await assert.rejects(
		() =>
			store.resolve(
				{
					path: "/attachments/scopes/channel/agent/slack/T1/C1/incoming/slack/1700.1/F123-hello.txt",
					name: "hello.txt",
				},
				other.channel,
			),
		/scope mismatch/,
	);
});

test("runtimeAttachments writes sanitized files under runtime root", async () => {
	const root = await mkdtemp(join(tmpdir(), "heypi-attachments-"));
	const store = runtimeAttachments(runtime(root, "just-bash"));

	const file = await store.save({
		provider: "slack",
		id: "../F123",
		name: "../hello world.txt",
		data: new TextEncoder().encode("hello"),
		mimeType: "text/plain",
		messageId: "1700.1",
	});

	assert.equal(file.path, "/incoming/slack/1700.1/F123-hello_world.txt");
	assert.equal(file.size, 5);
	assert.equal(await readFile(join(root, "incoming/slack/1700.1/F123-hello_world.txt"), "utf8"), "hello");
});

test("attachmentInput inlines text and passes images separately", async () => {
	const root = await mkdtemp(join(tmpdir(), "heypi-attachment-input-"));
	await writeFile(join(root, "note.txt"), "hello", "utf8");
	await writeFile(join(root, "image.png"), Buffer.from("png bytes"));

	const out = await attachmentInput(runtime(root, "host-bash"), "review", [
		{ name: "note.txt", path: "note.txt", mimeType: "text/plain", size: 5 },
		{ name: "image.png", path: "image.png", mimeType: "image/png", size: 9 },
	]);

	assert.equal(out.text, 'review\n<file name="note.txt">\nhello\n</file>\n<file name="image.png"></file>');
	assert.deepEqual(out.images, [
		{ type: "image", data: Buffer.from("png bytes").toString("base64"), mimeType: "image/png" },
	]);
});

test("attachmentInput keeps unsupported binaries as references", async () => {
	const root = await mkdtemp(join(tmpdir(), "heypi-attachment-bin-"));
	await writeFile(join(root, "file.pdf"), Buffer.from("%PDF"));

	const out = await attachmentInput(runtime(root, "host-bash"), "review", [
		{ name: "file.pdf", path: "file.pdf", mimeType: "application/pdf", size: 4 },
	]);

	assert.equal(out.text, "review\nAttachments:\n- file.pdf: file.pdf (application/pdf, 4 bytes)");
	assert.deepEqual(out.images, []);
});

test("attachmentInput can convert supported binaries with optional document command", async () => {
	const root = await mkdtemp(join(tmpdir(), "heypi-attachment-document-"));
	const command = join(root, "convert-document.mjs");
	await writeFile(join(root, "file.pdf"), Buffer.from("%PDF"));
	await writeFile(
		command,
		[
			"#!/usr/bin/env node",
			"import { readFileSync } from 'node:fs';",
			"const path = process.argv[2];",
			"readFileSync(path);",
			"process.stdout.write('# Converted\\n\\nbody');",
		].join("\n"),
		"utf8",
	);
	await chmod(command, 0o755);

	const out = await attachmentInput(
		runtime(root, "host-bash"),
		"review",
		[{ name: "file.pdf", path: "file.pdf", mimeType: "application/pdf", size: 4 }],
		{ documents: { command, extensions: [".pdf"], timeoutMs: 5000 } },
	);

	assert.equal(out.text, 'review\n<file name="file.pdf">\n# Converted\n\nbody\n</file>');
	assert.deepEqual(out.images, []);
});

test("attachmentInput falls back to references when document conversion is disabled", async () => {
	const root = await mkdtemp(join(tmpdir(), "heypi-attachment-document-disabled-"));
	await writeFile(join(root, "file.pdf"), Buffer.from("%PDF"));

	const out = await attachmentInput(
		runtime(root, "host-bash"),
		"review",
		[{ name: "file.pdf", path: "file.pdf", mimeType: "application/pdf", size: 4 }],
		{ documents: false },
	);

	assert.equal(out.text, "review\nAttachments:\n- file.pdf: file.pdf (application/pdf, 4 bytes)");
	assert.deepEqual(out.images, []);
});

test("runtimeAttachments rejects oversized inbound files", async () => {
	const root = await mkdtemp(join(tmpdir(), "heypi-attachments-limit-"));
	const store = runtimeAttachments(runtime(root, "just-bash"), { maxBytes: 4 });

	await assert.rejects(
		() =>
			store.save({
				provider: "slack",
				name: "hello.txt",
				data: new TextEncoder().encode("hello"),
			}),
		/exceeds limit/,
	);
});

test("runtimeAttachments resolves outbound files under runtime root", async () => {
	const root = await mkdtemp(join(tmpdir(), "heypi-outbound-"));
	await writeFile(join(root, "report.txt"), "hello");
	const store = runtimeAttachments(runtime(root, "host-bash"));

	const file = await store.resolve({ path: "report.txt", name: "../final report.txt", mimeType: "text/plain" });

	assert.equal(file.path, await realpath(join(root, "report.txt")));
	assert.equal(file.name, "final_report.txt");
	assert.equal(file.mimeType, "text/plain");
	assert.equal(file.size, 5);
	await assert.rejects(() => store.resolve({ path: "../outside.txt" }), /escapes runtime root/);
});

test("runtimeAttachments rejects symlink escapes", async () => {
	const root = await mkdtemp(join(tmpdir(), "heypi-outbound-link-"));
	const outside = await mkdtemp(join(tmpdir(), "heypi-outside-"));
	await writeFile(join(outside, "secret.txt"), "secret");
	await symlink(join(outside, "secret.txt"), join(root, "link.txt"));
	const store = runtimeAttachments(runtime(root, "host-bash"));

	await assert.rejects(() => store.resolve({ path: "link.txt" }), /escapes runtime root/);
});

test("saveInboundAttachments applies shared size, save, and failure policy", async () => {
	const logs: Array<{ event: string; fields: Record<string, unknown> }> = [];
	const saved: string[] = [];
	const store: AttachmentStore = {
		maxBytes: 4,
		async save(input) {
			saved.push(input.name);
			return {
				name: input.name,
				path: `/incoming/${input.name}`,
				size: input.data.byteLength,
				scope: input.scope?.path,
			};
		},
		async resolve() {
			throw new Error("unused");
		},
	};
	const scope = resolveScope({
		agent: "a",
		provider: "slack",
		kind: "slack",
		team: "T",
		channel: "C",
		actor: "U",
	}).channel;

	const out = await saveInboundAttachments({
		provider: "slack",
		kind: "slack",
		store,
		scope,
		trace: "trace",
		messageId: "m1",
		logItemField: "file",
		logger: logger(logs),
		refs: [
			{ id: "ok", name: "ok.txt", size: 2 },
			{ id: "big", name: "big.txt", size: 5 },
			{ id: "bad", name: "bad.txt", size: 1 },
		],
		download: async (ref) => {
			if (ref.id === "bad") throw new Error("download failed");
			return new TextEncoder().encode("ok");
		},
	});

	assert.deepEqual(saved, ["ok.txt"]);
	assert.deepEqual(
		out?.map((file) => file.path),
		["/incoming/ok.txt"],
	);
	assert.deepEqual(
		logs.map((entry) => entry.event),
		["slack.attachment_too_large", "slack.attachment_failed"],
	);
	assert.equal(logs[0]?.fields.file, "big");
	assert.equal(logs[1]?.fields.file, "bad");
});

test("resolveOutboundAttachments applies shared store and max-size policy", async () => {
	const logs: Array<{ event: string; fields: Record<string, unknown> }> = [];
	const files = new Map<string, ResolvedAttachment>([
		["ok.txt", { path: "/tmp/ok.txt", name: "ok.txt", size: 2 }],
		["big.txt", { path: "/tmp/big.txt", name: "big.txt", size: 5 }],
	]);
	const store: AttachmentStore = {
		maxBytes: 4,
		async save() {
			throw new Error("unused");
		},
		async resolve(input) {
			const file = files.get(input.path);
			if (!file) throw new Error("missing");
			return file;
		},
	};

	const out = await resolveOutboundAttachments({
		provider: "telegram",
		store,
		attachments: [{ path: "ok.txt" }, { path: "big.txt" }, { path: "missing.txt" }],
		logger: logger(logs),
		context: { trace: "trace" },
	});

	assert.deepEqual(
		out.map((file) => file.name),
		["ok.txt"],
	);
	assert.deepEqual(
		logs.map((entry) => entry.event),
		["telegram.attachment_upload_too_large", "telegram.attachment_resolve_failed"],
	);
	assert.equal(logs[0]?.fields.path, "big.txt");
	assert.equal(logs[1]?.fields.path, "missing.txt");
});

test("resolveOutboundAttachments forwards scope to the attachment store", async () => {
	const logs: Array<{ event: string; fields: Record<string, unknown> }> = [];
	const scope = resolveScope({
		agent: "a",
		provider: "slack",
		kind: "slack",
		team: "T",
		channel: "C",
		actor: "U",
	}).channel;
	let receivedScope: string | undefined;
	const store: AttachmentStore = {
		async save() {
			throw new Error("unused");
		},
		async resolve(_input, inputScope) {
			receivedScope = inputScope?.path;
			return { path: "/tmp/out.txt", name: "out.txt", size: 1 };
		},
	};

	const out = await resolveOutboundAttachments({
		provider: "slack",
		store,
		scope,
		attachments: [{ path: "/scopes/channel/a/slack/T/C/out.txt", scope: scope.path }],
		logger: logger(logs),
		context: { trace: "trace" },
	});

	assert.deepEqual(
		out.map((file) => file.name),
		["out.txt"],
	);
	assert.equal(receivedScope, scope.path);
	assert.deepEqual(logs, []);
});

test("resolveOutboundAttachments logs missing store once", async () => {
	const logs: Array<{ event: string; fields: Record<string, unknown> }> = [];

	const out = await resolveOutboundAttachments({
		provider: "discord",
		attachments: [{ path: "out.txt" }],
		logger: logger(logs),
		context: { trace: "trace" },
	});

	assert.deepEqual(out, []);
	assert.deepEqual(logs, [{ event: "discord.attachments_missing_store", fields: { trace: "trace" } }]);
});

test("responseBytes stops reading above the byte limit", async () => {
	const response = new Response("hello");

	await assert.rejects(() => responseBytes(response, 4), /exceeds limit/);
});

function runtime(root: string, name: Runtime["name"]): Runtime {
	return { name, root, capabilities: {} };
}

function logger(logs: Array<{ event: string; fields: Record<string, unknown> }>) {
	return {
		debug() {},
		info() {},
		warn(event: string, fields: Record<string, unknown>) {
			logs.push({ event, fields });
		},
		error() {},
	};
}

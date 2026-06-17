import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { CallRunner } from "../src/core/calls.js";
import { createHandler } from "../src/io/handler.js";
import { Queue } from "../src/runtime/queue.js";
import { sqliteStore } from "../src/store/sqlite.js";

test("threads are isolated by Slack team", async () => {
	const root = await mkdtemp(join(tmpdir(), "heypi-thread-"));
	try {
		const store = sqliteStore({ path: join(root, "heypi.db") });
		await store.setup();
		const first = await store.threads.getOrCreate({
			agent: "a",
			provider: "slack",
			team: "T1",
			channel: "C1",
			key: "C1:123",
		});
		const second = await store.threads.getOrCreate({
			agent: "a",
			provider: "slack",
			team: "T2",
			channel: "C1",
			key: "C1:123",
		});

		assert.notEqual(first.id, second.id);
		assert.equal(first.team, "T1");
		assert.equal(second.team, "T2");
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("provider event dedupe is scoped to the thread", async () => {
	const root = await mkdtemp(join(tmpdir(), "heypi-message-"));
	try {
		const store = sqliteStore({ path: join(root, "heypi.db") });
		await store.setup();
		const first = await store.threads.getOrCreate({
			agent: "a",
			provider: "slack",
			team: "T1",
			channel: "C1",
			key: "C1:123",
		});
		const second = await store.threads.getOrCreate({
			agent: "a",
			provider: "slack",
			team: "T2",
			channel: "C1",
			key: "C1:123",
		});

		const one = await store.messages.createOnce({
			threadId: first.id,
			provider: "slack",
			providerEventId: "event-1",
			role: "user",
			text: "one",
		});
		const two = await store.messages.createOnce({
			threadId: second.id,
			provider: "slack",
			providerEventId: "event-1",
			role: "user",
			text: "two",
		});

		assert.equal(one.inserted, true);
		assert.equal(two.inserted, true);
		assert.notEqual(one.row.id, two.row.id);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("provider message index resolves provider messages across thread lookup", async () => {
	const root = await mkdtemp(join(tmpdir(), "heypi-provider-message-"));
	try {
		const store = sqliteStore({ path: join(root, "heypi.db") });
		await store.setup();
		assert.ok(store.providerMessages);
		const thread = await store.threads.getOrCreate({
			agent: "a",
			provider: "discord",
			team: "G1",
			channel: "C1",
			actor: "U1",
			key: "C1:M1",
		});

		await store.providerMessages.upsert({
			agent: "a",
			provider: "discord",
			team: "G1",
			channel: "C1",
			providerMessageId: "M2",
			threadId: thread.id,
			actor: "BOT",
		});

		const found = await store.providerMessages.get({
			agent: "a",
			provider: "discord",
			team: "G1",
			channel: "C1",
			providerMessageId: "M2",
		});
		assert.equal(found?.threadId, thread.id);
		assert.equal((await store.threads.get(found?.threadId ?? ""))?.key, "C1:M1");
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("handler indexes provider messages separately from provider events", async () => {
	const root = await mkdtemp(join(tmpdir(), "heypi-provider-message-event-"));
	try {
		const store = sqliteStore({ path: join(root, "heypi.db") });
		await store.setup();
		assert.ok(store.providerMessages);
		const handler = createHandler({
			agentId: "a",
			store,
			callRunner: new CallRunner(
				store.calls,
				store.approvals,
				new Queue({ maxConcurrent: 1, maxPerChat: 1 }),
				{ name: "none", root: "." },
				{},
				undefined,
				store.transaction,
			),
			agent: {
				ask: async () => ({ text: "ok" }),
				continue: async () => ({ text: "ok" }),
			},
		});

		await handler({
			provider: "telegram",
			eventId: "update-100",
			providerMessageId: "message-10",
			channel: "chat-1",
			actor: "user-1",
			thread: "chat-1:message-10",
			text: "hello",
		});

		const byMessage = await store.providerMessages.get({
			agent: "a",
			provider: "telegram",
			channel: "chat-1",
			providerMessageId: "message-10",
		});
		const byEvent = await store.providerMessages.get({
			agent: "a",
			provider: "telegram",
			channel: "chat-1",
			providerMessageId: "update-100",
		});

		assert.equal(byMessage?.actor, "user-1");
		assert.equal(byEvent, undefined);
		assert.equal((await store.threads.get(byMessage?.threadId ?? ""))?.key, "chat-1:message-10");
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("thread recency follows new messages for same-actor continuation", async () => {
	const root = await mkdtemp(join(tmpdir(), "heypi-thread-recency-"));
	try {
		const store = sqliteStore({ path: join(root, "heypi.db") });
		await store.setup();
		const row = await store.threads.getOrCreate({
			agent: "a",
			provider: "telegram",
			channel: "C1",
			actor: "U1",
			key: "C1:M1",
		});

		await store.messages.create({
			threadId: row.id,
			provider: "telegram",
			providerEventId: "M1",
			role: "user",
			actor: "U1",
			text: "hello",
		});

		const recent = await store.threads.getRecentForActor?.({
			agent: "a",
			provider: "telegram",
			channel: "C1",
			actor: "U1",
			since: Date.now() - 60_000,
		});
		assert.equal(recent?.id, row.id);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("approval bypass adapter scope treats adapter names literally", async () => {
	const root = await mkdtemp(join(tmpdir(), "heypi-bypass-adapter-"));
	try {
		const store = sqliteStore({ path: join(root, "heypi.db") });
		await store.setup();
		assert.ok(store.approvalBypasses);

		const bypass = await store.approvalBypasses.create({
			agent: "a",
			scope: "adapter",
			channel: "my_slack:T1:C1",
			actor: "U1",
			createdBy: "U_APPROVER",
			expiresAt: Date.now() + 60_000,
		});

		assert.equal(
			(
				await store.approvalBypasses.active({
					agent: "a",
					channel: "my_slack:T2:C2",
					actor: "U1",
				})
			)?.id,
			bypass.id,
		);
		assert.equal(
			await store.approvalBypasses.active({
				agent: "a",
				channel: "myXslack:T2:C2",
				actor: "U1",
			}),
			undefined,
		);
		assert.equal(
			await store.approvalBypasses.active({
				agent: "a",
				channel: "my_slack:T2:C2",
				actor: "U2",
			}),
			undefined,
		);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

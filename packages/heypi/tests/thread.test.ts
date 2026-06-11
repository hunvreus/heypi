import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
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

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { sqliteStore } from "../src/store/sqlite.js";

async function tempDb(): Promise<{ path: string; cleanup: () => Promise<void> }> {
	const dir = await mkdtemp(join(tmpdir(), "heypi-approval-bypass-"));
	return { path: join(dir, "store.db"), cleanup: () => rm(dir, { recursive: true, force: true }) };
}

test("adapter-scoped bypass matching treats glob characters as literal adapter names", async () => {
	const db = await tempDb();
	try {
		const store = sqliteStore({ path: db.path });
		await store.setup();
		assert.ok(store.approvalBypasses);
		const expiresAt = Date.now() + 60_000;
		await store.approvalBypasses.create({
			agent: "a",
			scope: "adapter",
			channel: "custom*:C1",
			actor: "U1",
			createdBy: "U_ADMIN",
			expiresAt,
		});

		assert.equal(
			await store.approvalBypasses.active({
				agent: "a",
				channel: "custom-other:C1",
				actor: "U1",
			}),
			undefined,
		);
		assert.equal(
			(
				await store.approvalBypasses.active({
					agent: "a",
					channel: "custom*:C2",
					actor: "U1",
				})
			)?.channel,
			"custom*:C1",
		);
	} finally {
		await db.cleanup();
	}
});

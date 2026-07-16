import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { listAuditConversations, readAuditConversation } from "../src/audit.js";

async function makeDir(name: string): Promise<string> {
	const root = join(tmpdir(), `heypi-${name}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	await mkdir(root, { recursive: true });
	return root;
}

describe("audit", () => {
	it("lists conversation logs and reads coordination records", async () => {
		const state = await makeDir("audit");
		const first = join(state, "adapters", "local", "conversations", "a", "sessions", "session-a");
		const second = join(state, "adapters", "local", "conversations", "b", "sessions", "session-b");
		await mkdir(first, { recursive: true });
		await mkdir(second, { recursive: true });
		await writeFile(
			join(second, "log.jsonl"),
			`${JSON.stringify({ type: "turn_completed", record: 2, id: "t1", trigger: 1 })}\n`,
		);
		await writeFile(
			join(first, "log.jsonl"),
			`${JSON.stringify({
				type: "message_inbound",
				record: 1,
				id: "m1",
				adapter: "local",
				adapterId: "local",
				conversation: "local",
				user: { id: "u1" },
				text: "hello",
				mentioned: true,
				dm: true,
			})}\n`,
		);

		const listed = await listAuditConversations({ stateDir: state });
		expect(listed).toEqual([
			{ key: "local/a/session-a", path: join(first, "log.jsonl"), dir: first },
			{ key: "local/b/session-b", path: join(second, "log.jsonl"), dir: second },
		]);

		await expect(readAuditConversation(listed[0]?.path ?? "")).resolves.toMatchObject([
			{ type: "message_inbound", record: 1, id: "m1", text: "hello" },
		]);
	});
});

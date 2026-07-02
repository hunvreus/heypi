import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { listAuditChannels, readAuditChannel } from "../src/audit.js";

async function makeDir(name: string): Promise<string> {
	const root = join(tmpdir(), `heypi-${name}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	await mkdir(root, { recursive: true });
	return root;
}

describe("audit", () => {
	it("returns no channels for an empty state directory", async () => {
		const state = await makeDir("audit-empty");

		await expect(listAuditChannels({ stateDir: state })).resolves.toEqual([]);
	});

	it("lists channel logs and reads coordination records", async () => {
		const state = await makeDir("audit");
		const channels = join(state, "channels");
		await mkdir(channels, { recursive: true });
		await writeFile(
			join(channels, "b.jsonl"),
			`${JSON.stringify({ type: "turn_completed", record: 2, id: "t1", trigger: 1 })}\n`,
		);
		await writeFile(
			join(channels, "a.jsonl"),
			`${JSON.stringify({
				type: "inbound",
				record: 1,
				id: "m1",
				adapter: "local",
				account: "local",
				conversation: "local",
				user: { id: "u1" },
				text: "hello",
				mentioned: true,
				dm: true,
			})}\n`,
		);
		await writeFile(join(channels, "ignore.txt"), "nope");

		const listed = await listAuditChannels({ stateDir: state });
		expect(listed).toEqual([
			{ key: "a", path: join(channels, "a.jsonl") },
			{ key: "b", path: join(channels, "b.jsonl") },
		]);

		await expect(readAuditChannel(listed[0]?.path ?? "")).resolves.toMatchObject([
			{ type: "inbound", record: 1, id: "m1", text: "hello" },
		]);
	});
});

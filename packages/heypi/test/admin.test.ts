import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createAdmin } from "../src/admin.js";

function freePort(): number {
	return 20_000 + Math.floor(Math.random() * 20_000);
}

async function makeDir(name: string): Promise<string> {
	const root = join(tmpdir(), `heypi-${name}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	await mkdir(root, { recursive: true });
	return root;
}

describe("admin", () => {
	it("serves health and read-only channel audit records", async () => {
		const state = await makeDir("admin");
		await mkdir(join(state, "channels"), { recursive: true });
		await writeFile(
			join(state, "channels", "local:local:local.jsonl"),
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
		const admin = createAdmin({ stateDir: state, port: freePort() });
		await admin.start();
		try {
			await expect(fetch(admin.url()).then((response) => response.json())).resolves.toEqual({
				ok: true,
				endpoints: {
					health: "/admin/health",
					jobs: "/admin/jobs",
					channels: "/admin/channels",
				},
			});
			await expect(fetch(`${admin.url()}/health`).then((response) => response.json())).resolves.toEqual({
				ok: true,
			});
			await expect(fetch(`${admin.url()}/channels`).then((response) => response.json())).resolves.toEqual({
				channels: ["local:local:local"],
			});
			await expect(fetch(`${admin.url()}/jobs`).then((response) => response.json())).resolves.toEqual({
				jobs: [],
			});
			await expect(
				fetch(`${admin.url()}/channels/local%3Alocal%3Alocal`).then((response) => response.json()),
			).resolves.toMatchObject({
				key: "local:local:local",
				records: [{ type: "inbound", text: "hello" }],
			});
		} finally {
			await admin.stop();
		}
	});
});

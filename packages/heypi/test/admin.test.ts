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
		const logDir = join(state, "accounts", "local", "channels", "local", "sessions", "local-session");
		await mkdir(logDir, { recursive: true });
		await writeFile(
			join(logDir, "log.jsonl"),
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
					cancelJobs: "/admin/jobs/cancel",
					channels: "/admin/channels",
				},
			});
			await expect(fetch(`${admin.url()}/health`).then((response) => response.json())).resolves.toEqual({
				ok: true,
			});
			await expect(fetch(`${admin.url()}/channels`).then((response) => response.json())).resolves.toEqual({
				channels: ["local/local/local-session"],
			});
			await expect(fetch(`${admin.url()}/jobs`).then((response) => response.json())).resolves.toEqual({
				jobs: [],
			});
			await expect(
				fetch(`${admin.url()}/channels/${encodeURIComponent("local/local/local-session")}`).then((response) =>
					response.json(),
				),
			).resolves.toMatchObject({
				key: "local/local/local-session",
				records: [{ type: "inbound", text: "hello" }],
			});
		} finally {
			await admin.stop();
		}
	});

	it("can cancel jobs through the admin endpoint", async () => {
		const state = await makeDir("admin-cancel");
		const calls: Array<{ scope: string; reason?: string }> = [];
		const admin = createAdmin({
			stateDir: state,
			port: freePort(),
			cancel: async (scope, reason) => {
				calls.push({ scope, reason });
				return { active: scope === "queued" ? 0 : 1, queued: scope === "active" ? 0 : 2 };
			},
		});
		await admin.start();
		try {
			await expect(
				fetch(`${admin.url()}/jobs/cancel`, {
					method: "POST",
					body: JSON.stringify({ scope: "queued", reason: "user canceled" }),
				}).then((response) => response.json()),
			).resolves.toEqual({ canceled: { active: 0, queued: 2 } });
			expect(calls).toEqual([{ scope: "queued", reason: "user canceled" }]);
		} finally {
			await admin.stop();
		}
	});

	it("rejects malformed request bodies without crashing", async () => {
		const state = await makeDir("admin-bad-json");
		const admin = createAdmin({
			stateDir: state,
			port: freePort(),
			cancel: async () => ({ active: 0, queued: 0 }),
		});
		await admin.start();
		try {
			await expect(
				fetch(`${admin.url()}/jobs/cancel`, {
					method: "POST",
					body: "{",
				}).then((response) => response.json()),
			).resolves.toEqual({ error: "bad_request" });
			await expect(fetch(`${admin.url()}/health`).then((response) => response.json())).resolves.toEqual({
				ok: true,
			});
		} finally {
			await admin.stop();
		}
	});

	it("requires the configured admin token", async () => {
		const state = await makeDir("admin-token");
		const admin = createAdmin({ stateDir: state, port: freePort(), token: "secret" });
		await admin.start();
		try {
			await expect(fetch(admin.url()).then((response) => response.json())).resolves.toEqual({
				error: "unauthorized",
			});
			await expect(
				fetch(admin.url(), { headers: { authorization: "Bearer secret" } }).then((response) => response.json()),
			).resolves.toMatchObject({ ok: true });
			await expect(
				fetch(admin.url(), { headers: { "x-heypi-admin-token": "secret" } }).then((response) => response.json()),
			).resolves.toMatchObject({ ok: true });
		} finally {
			await admin.stop();
		}
	});

	it("requires an admin token for non-loopback hosts", async () => {
		const state = await makeDir("admin-non-loopback");
		const admin = createAdmin({ stateDir: state, host: "0.0.0.0", port: freePort() });

		await expect(admin.start()).rejects.toThrow("Admin token is required");
	});

	it("serves an HTML dashboard to browsers", async () => {
		const state = await makeDir("admin-html");
		const logDir = join(state, "accounts", "local", "channels", "room", "sessions", "room-session");
		await mkdir(logDir, { recursive: true });
		await writeFile(
			join(logDir, "log.jsonl"),
			`${JSON.stringify({
				type: "inbound",
				record: 1,
				id: "m1",
				adapter: "local",
				account: "local",
				conversation: "room",
				user: { id: "u1", name: "Ronan" },
				text: "hello",
				mentioned: true,
				dm: true,
			})}\n`,
		);
		const admin = createAdmin({
			stateDir: state,
			port: freePort(),
			jobs: () => [
				{
					id: "j1",
					state: "running",
					adapter: "local",
					account: "local",
					conversation: "room",
					actor: { id: "u1", name: "Ronan" },
				},
			],
		});
		await admin.start();
		try {
			const response = await fetch(admin.url(), { headers: { accept: "text/html" } });
			const html = await response.text();
			expect(response.headers.get("content-type")).toContain("text/html");
			expect(html).toContain("<h1>heypi admin</h1>");
			expect(html).toContain("Cancel active");
			expect(html).toContain("Ronan");
			expect(html).toContain("local/room/room-session");
		} finally {
			await admin.stop();
		}
	});

	it("serves the secret page and accepts encrypted secret replies without an admin token", async () => {
		const state = await makeDir("admin-secret");
		const accepted: string[] = [];
		const admin = createAdmin({
			stateDir: state,
			port: freePort(),
			token: "admin-token",
			secret: {
				pageHtml: () => "<!doctype html><title>secret</title>",
				accept: async (reply) => {
					accepted.push(reply);
					return { name: "github-token" };
				},
			},
		});
		await admin.start();
		try {
			const html = await fetch(`${admin.url()}/secret`).then((response) => response.text());
			expect(html).toContain("<title>secret</title>");
			await expect(
				fetch(`${admin.url()}/secret`, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ reply: "!secret:id:payload" }),
				}).then((response) => response.json()),
			).resolves.toEqual({ ok: true, name: "github-token" });
			expect(accepted).toEqual(["!secret:id:payload"]);
		} finally {
			await admin.stop();
		}
	});
});

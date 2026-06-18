import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Logger } from "@hunvreus/heypi";
import {
	loadAgent,
	commandConfirm,
	consoleLogger,
	defaultTools,
	createHeypi,
	defineEval,
	loadEvals,
	local,
	runHeypi,
	slack,
	sqliteStore,
	tool,
	workspace,
} from "@hunvreus/heypi";
import type { Adapter } from "@hunvreus/heypi/adapter";
import type { AttachmentStore } from "@hunvreus/heypi/attachments";
import { Type } from "@sinclair/typebox";

test("public package entrypoint supports a minimal app config", async () => {
	const root = await mkdtemp(join(tmpdir(), "heypi-public-api-"));
	try {
		const adapter: Adapter = {
			name: "test",
			kind: "test",
			start: async () => undefined,
			stop: async () => undefined,
		};
		const lookup = tool<{ name: string }>({
			name: "lookup",
			description: "Lookup a value",
			parameters: Type.Object({ name: Type.String() }),
			execute: async ({ name }) => `name=${name}`,
		});
		const app = createHeypi({
			store: sqliteStore({ path: join(root, "heypi.db") }),
			state: { root: join(root, "state") },
			logger: consoleLogger({ level: "error", format: "pretty" }),
			adapters: [adapter],
			agent: loadAgent("../../examples/slack-devops/agent", {
				model: "openai/gpt-5-mini",
				tools: [...defaultTools({ bash: { confirm: commandConfirm({ allow: [/^curl -I /] }) } }), lookup],
			}),
			runtime: {
				name: "just-bash",
				root: workspace(join(root, "workspace")),
			},
		});
		assert.equal(typeof app.start, "function");
		assert.equal(typeof app.stop, "function");
		assert.equal(typeof defineEval, "function");
		assert.equal(typeof loadEvals, "function");
		assert.equal(typeof local, "function");
		assert.equal(typeof runHeypi, "function");
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("createHeypi requires state.root", async () => {
	const adapter: Adapter = {
		name: "test",
		kind: "test",
		start: async () => undefined,
	};
	assert.throws(
		() =>
			createHeypi({
				logger: consoleLogger({ level: "error", format: "pretty" }),
				adapters: [adapter],
				agent: loadAgent("../../examples/slack-devops/agent", { id: "default", model: "openai/gpt-5-mini" }),
				runtime: { name: "host-bash", root: workspace("./workspace") },
			} as unknown as Parameters<typeof createHeypi>[0]),
		/state\.root is required/,
	);
});

test("createHeypi rejects legacy root approval actors", async () => {
	const root = await mkdtemp(join(tmpdir(), "heypi-public-api-legacy-approval-"));
	try {
		const adapter: Adapter = {
			name: "test",
			kind: "test",
			start: async () => undefined,
		};
		assert.throws(
			() =>
				createHeypi({
					state: { root: join(root, "state") },
					logger: consoleLogger({ level: "error", format: "pretty" }),
					approval: { approvers: ["U_OLD"] },
					adapters: [adapter],
					agent: loadAgent("../../examples/slack-devops/agent", { id: "default", model: "openai/gpt-5-mini" }),
					runtime: {
						name: "host-bash",
						root: workspace(join(root, "workspace")),
					},
				} as unknown as Parameters<typeof createHeypi>[0]),
			/approval\.approvers\/admins moved to adapter\.permissions/,
		);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("createHeypi warns about unknown shallow config keys", async () => {
	const root = await mkdtemp(join(tmpdir(), "heypi-public-api-unknown-config-"));
	try {
		const warnings: Record<string, unknown>[] = [];
		const adapter: Adapter = {
			name: "test",
			kind: "test",
			start: async () => undefined,
		};
		createHeypi({
			state: { root: join(root, "state") },
			logger: fakeLogger(warnings),
			approval: { expiresInMs: 60_000, legacy: true },
			adapters: [adapter],
			agent: loadAgent("../../examples/slack-devops/agent", { id: "default", model: "openai/gpt-5-mini" }),
			runtime: {
				name: "host-bash",
				root: workspace(join(root, "workspace")),
			},
			experimentalUnknown: true,
		} as unknown as Parameters<typeof createHeypi>[0]);

		assert.deepEqual(
			warnings.filter((row) => row.event === "config.unknown_key").map((row) => row.path),
			["config.experimentalUnknown", "config.approval.legacy"],
		);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("createHeypi uses state.root for the default SQLite store", async () => {
	const root = await mkdtemp(join(tmpdir(), "heypi-public-api-default-store-"));
	const cwd = process.cwd();
	try {
		process.chdir(root);
		await mkdir(join(root, "agent"));
		const adapter: Adapter = {
			name: "test",
			kind: "test",
			start: async () => undefined,
			stop: async () => undefined,
		};
		const app = createHeypi({
			state: { root: "./state" },
			logger: consoleLogger({ level: "error", format: "pretty" }),
			adapters: [adapter],
			agent: loadAgent(join(root, "agent"), { id: "default", model: "openai/gpt-5-mini" }),
			runtime: {
				name: "host-bash",
				root: workspace(join(root, "workspace")),
			},
		});

		await app.start();
		await app.stop();

		assert.equal((await stat(join(root, "state", "heypi.db"))).isFile(), true);
	} finally {
		process.chdir(cwd);
		await rm(root, { recursive: true, force: true });
	}
});

test("createHeypi warns about risky startup security posture", async () => {
	const root = await mkdtemp(join(tmpdir(), "heypi-public-api-security-warnings-"));
	try {
		const warnings: Record<string, unknown>[] = [];
		createHeypi({
			state: { root: join(root, "state") },
			http: { host: "0.0.0.0", port: 0 },
			logger: fakeLogger(warnings),
			adapters: [{ name: "test", kind: "test", start: async () => undefined }],
			agent: loadAgent("../../examples/slack-devops/agent", { id: "default", model: "openai/gpt-5-mini" }),
			runtime: {
				name: "host-bash",
				root: workspace(join(root, "workspace")),
			},
		});

		assert.deepEqual(
			warnings.map((row) => row.event),
			["security.runtime_host", "security.http_public", "security.approvers_missing"],
		);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("createHeypi treats adapter approval admins as configured approval actors", async () => {
	const root = await mkdtemp(join(tmpdir(), "heypi-public-api-security-admins-"));
	try {
		const warnings: Record<string, unknown>[] = [];
		createHeypi({
			state: { root: join(root, "state") },
			logger: fakeLogger(warnings),
			adapters: [{ name: "test", kind: "test", permissions: { admins: ["U_ADMIN"] }, start: async () => undefined }],
			agent: loadAgent("../../examples/slack-devops/agent", { id: "default", model: "openai/gpt-5-mini" }),
			runtime: {
				name: "host-bash",
				root: workspace(join(root, "workspace")),
			},
		});

		assert.equal(
			warnings.some((row) => row.event === "security.approvers_missing"),
			false,
		);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("createHeypi warns when bot input is enabled without approval actors", async () => {
	const root = await mkdtemp(join(tmpdir(), "heypi-public-api-bot-approver-warning-"));
	try {
		const warnings: Record<string, unknown>[] = [];
		createHeypi({
			state: { root: join(root, "state") },
			logger: fakeLogger(warnings),
			adapters: [{ name: "test", kind: "test", acceptsBots: true, start: async () => undefined }],
			agent: loadAgent("../../examples/slack-devops/agent", { id: "default", model: "openai/gpt-5-mini" }),
			runtime: {
				name: "host-bash",
				root: workspace(join(root, "workspace")),
			},
		});

		assert.equal(
			warnings.some((row) => row.event === "security.bot_approvers_missing"),
			true,
		);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("createHeypi passes adapter approval permissions to the adapter handler", async () => {
	const root = await mkdtemp(join(tmpdir(), "heypi-public-api-adapter-permissions-"));
	try {
		const store = sqliteStore({ path: join(root, "heypi.db") });
		let approval: Parameters<Adapter["start"]>[0]["approval"];
		const adapter: Adapter = {
			name: "test",
			kind: "test",
			permissions: { approvers: ["U_ADAPTER_APPROVER"], admins: ["U_ADAPTER_ADMIN"] },
			start: async (input) => {
				approval = input.approval;
			},
		};
		const app = createHeypi({
			store,
			state: { root: join(root, "state") },
			logger: consoleLogger({ level: "error", format: "pretty" }),
			approval: { expiresInMs: 60_000 },
			adapters: [adapter],
			agent: loadAgent("../../examples/slack-devops/agent", { id: "default", model: "openai/gpt-5-mini" }),
			runtime: {
				name: "host-bash",
				root: workspace(join(root, "workspace")),
			},
		});

		await app.start();
		await app.stop();

		assert.equal(approval?.expiresInMs, 60_000);
		assert.deepEqual(approval?.approvers, ["U_ADAPTER_APPROVER"]);
		assert.deepEqual(approval?.admins, ["U_ADAPTER_ADMIN"]);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("createHeypi passes injected attachment store to adapters", async () => {
	const root = await mkdtemp(join(tmpdir(), "heypi-public-api-attachments-"));
	try {
		let received: AttachmentStore | undefined;
		const attachments: AttachmentStore = {
			save: async () => ({ name: "in.txt", path: "in.txt" }),
			resolve: async () => ({ name: "out.txt", path: join(root, "out.txt"), size: 0 }),
		};
		const adapter: Adapter = {
			name: "test",
			kind: "test",
			start: async (input) => {
				received = input.attachments;
			},
		};
		const app = createHeypi({
			store: sqliteStore({ path: join(root, "heypi.db") }),
			state: { root: join(root, "state") },
			logger: consoleLogger({ level: "error", format: "pretty" }),
			adapters: [adapter],
			attachments: { store: attachments },
			agent: loadAgent("../../examples/slack-devops/agent", { id: "default", model: "openai/gpt-5-mini" }),
			runtime: {
				name: "host-bash",
				root: workspace(join(root, "workspace")),
			},
		});

		await app.start();

		assert.equal(received, attachments);
		await app.stop();
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("createHeypi stops started adapters when a later adapter fails to start", async () => {
	const root = await mkdtemp(join(tmpdir(), "heypi-public-api-startup-"));
	try {
		const store = sqliteStore({ path: join(root, "heypi.db") });
		let stopped = false;
		const first: Adapter = {
			name: "first",
			kind: "test",
			start: async () => undefined,
			stop: async () => {
				stopped = true;
			},
		};
		const second: Adapter = {
			name: "second",
			kind: "test",
			start: async () => {
				throw new Error("boom");
			},
		};
		const app = createHeypi({
			store,
			state: { root: join(root, "state") },
			logger: consoleLogger({ level: "error", format: "pretty" }),
			adapters: [first, second],
			agent: loadAgent("../../examples/slack-devops/agent", { id: "default", model: "openai/gpt-5-mini" }),
			runtime: {
				name: "host-bash",
				root: workspace(join(root, "workspace")),
			},
		});

		await assert.rejects(() => app.start(), /boom/);
		assert.equal(stopped, true);
		assert.equal(await store.locks?.get("app:default"), undefined);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("createHeypi rejects duplicate adapter names", async () => {
	const root = await mkdtemp(join(tmpdir(), "heypi-public-api-duplicate-adapter-"));
	try {
		const store = sqliteStore({ path: join(root, "heypi.db") });
		assert.throws(
			() =>
				createHeypi({
					store,
					state: { root: join(root, "state") },
					logger: consoleLogger({ level: "error", format: "pretty" }),
					adapters: [
						{ name: "same", kind: "test", start: async () => undefined },
						{ name: "same", kind: "test", start: async () => undefined },
					],
					agent: loadAgent("../../examples/slack-devops/agent", { id: "default", model: "openai/gpt-5-mini" }),
					runtime: { name: "host-bash", root: workspace(join(root, "workspace")) },
				}),
			/duplicate adapter name: same/,
		);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("slack HTTP path overrides must be explicit", () => {
	assert.throws(
		() =>
			slack({
				botToken: "xoxb-test",
				signingSecret: "test-secret",
				mode: "http",
				path: "/slack/events",
			}),
		/unsafePathOverride: true/,
	);
});

test("createHeypi rejects admin as a user adapter name", async () => {
	const root = await mkdtemp(join(tmpdir(), "heypi-public-api-admin-name-"));
	try {
		const store = sqliteStore({ path: join(root, "heypi.db") });
		for (const kind of ["test", "admin"]) {
			assert.throws(
				() =>
					createHeypi({
						store,
						state: { root: join(root, "state") },
						logger: consoleLogger({ level: "error", format: "pretty" }),
						adapters: [{ name: "admin", kind, start: async () => undefined }],
						agent: loadAgent("../../examples/slack-devops/agent", { id: "default", model: "openai/gpt-5-mini" }),
						runtime: { name: "host-bash", root: workspace(join(root, "workspace")) },
					}),
				/adapter name is reserved: admin/,
			);
		}
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("createHeypi de-dupes internal admin adapter names", async () => {
	const root = await mkdtemp(join(tmpdir(), "heypi-public-api-internal-admin-name-"));
	try {
		const store = sqliteStore({ path: join(root, "heypi.db") });
		const app = createHeypi({
			store,
			logger: consoleLogger({ level: "error", format: "pretty" }),
			state: { root: join(root, "state") },
			http: { port: 0 },
			admin: { auth: false },
			adapters: [{ name: "test", kind: "test", start: async () => undefined }],
			agent: loadAgent("../../examples/slack-devops/agent", { id: "default", model: "openai/gpt-5-mini" }),
			runtime: { name: "host-bash", root: workspace(join(root, "workspace")) },
		});
		await app.start();
		await app.stop();
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("createHeypi serves HTTP routes from multiple adapters on one listener", async () => {
	const root = await mkdtemp(join(tmpdir(), "heypi-public-api-shared-http-"));
	const port = await freePort();
	try {
		const app = createHeypi({
			store: sqliteStore({ path: join(root, "heypi.db") }),
			state: { root: join(root, "state") },
			logger: consoleLogger({ level: "error", format: "pretty" }),
			http: { port },
			adapters: [
				{
					name: "a",
					kind: "test",
					start: async ({ http }) => {
						http?.register({
							method: "GET",
							path: "/a",
							handler: (_req, res) => {
								res.end("a");
							},
						});
					},
				},
				{
					name: "b",
					kind: "test",
					start: async ({ http }) => {
						http?.register({
							method: "GET",
							path: "/b",
							handler: (_req, res) => {
								res.end("b");
							},
						});
					},
				},
			],
			agent: loadAgent("../../examples/slack-devops/agent", { id: "default", model: "openai/gpt-5-mini" }),
			runtime: { name: "host-bash", root: workspace(join(root, "workspace")) },
		});
		await app.start();
		try {
			assert.equal(await (await fetch(`http://127.0.0.1:${port}/a`)).text(), "a");
			assert.equal(await (await fetch(`http://127.0.0.1:${port}/b`)).text(), "b");
		} finally {
			await app.stop();
		}
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("createHeypi rejects duplicate HTTP routes", async () => {
	const root = await mkdtemp(join(tmpdir(), "heypi-public-api-duplicate-http-"));
	const port = await freePort();
	try {
		const app = createHeypi({
			store: sqliteStore({ path: join(root, "heypi.db") }),
			state: { root: join(root, "state") },
			logger: consoleLogger({ level: "error", format: "pretty" }),
			adapters: [
				{
					name: "a",
					kind: "test",
					start: async ({ http }) => {
						http?.register({
							method: "GET",
							path: "/same",
							port,
							handler: (_req, res) => {
								res.end("a");
							},
						});
					},
				},
				{
					name: "b",
					kind: "test",
					start: async ({ http }) => {
						http?.register({
							method: "GET",
							path: "/same",
							port,
							handler: (_req, res) => {
								res.end("b");
							},
						});
					},
				},
			],
			agent: loadAgent("../../examples/slack-devops/agent", { id: "default", model: "openai/gpt-5-mini" }),
			runtime: { name: "host-bash", root: workspace(join(root, "workspace")) },
		});
		await assert.rejects(() => app.start(), /duplicate HTTP route: GET \/same/);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("createHeypi rejects non-admin HTTP routes under /admin", async () => {
	const root = await mkdtemp(join(tmpdir(), "heypi-public-api-admin-route-"));
	const port = await freePort();
	try {
		const app = createHeypi({
			store: sqliteStore({ path: join(root, "heypi.db") }),
			state: { root: join(root, "state") },
			logger: consoleLogger({ level: "error", format: "pretty" }),
			adapters: [
				{
					name: "custom",
					kind: "test",
					start: async ({ http }) => {
						http?.register({
							method: "GET",
							path: "/admin/status",
							port,
							handler: (_req, res) => {
								res.end("bad");
							},
						});
					},
				},
			],
			agent: loadAgent("../../examples/slack-devops/agent", { id: "default", model: "openai/gpt-5-mini" }),
			runtime: { name: "host-bash", root: workspace(join(root, "workspace")) },
		});
		await assert.rejects(() => app.start(), /HTTP route uses reserved path: \/admin\/status/);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("createHeypi rejects structurally conflicting HTTP routes", async () => {
	const root = await mkdtemp(join(tmpdir(), "heypi-public-api-http-shape-"));
	const port = await freePort();
	try {
		const app = createHeypi({
			store: sqliteStore({ path: join(root, "heypi.db") }),
			state: { root: join(root, "state") },
			logger: consoleLogger({ level: "error", format: "pretty" }),
			adapters: [
				{
					name: "a",
					kind: "test",
					start: async ({ http }) => {
						http?.register({
							method: "GET",
							path: "/threads/:id",
							port,
							handler: (_req, res) => {
								res.end("a");
							},
						});
					},
				},
				{
					name: "b",
					kind: "test",
					start: async ({ http }) => {
						http?.register({
							method: "GET",
							path: "/threads/:threadId",
							port,
							handler: (_req, res) => {
								res.end("b");
							},
						});
					},
				},
			],
			agent: loadAgent("../../examples/slack-devops/agent", { id: "default", model: "openai/gpt-5-mini" }),
			runtime: { name: "host-bash", root: workspace(join(root, "workspace")) },
		});
		await assert.rejects(
			() => app.start(),
			/conflicting HTTP route: GET \/threads\/:threadId conflicts with GET \/threads\/:id/,
		);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("admin registers reserved routes", async () => {
	const root = await mkdtemp(join(tmpdir(), "heypi-public-api-admin-routes-"));
	const port = await freePort();
	try {
		const app = createHeypi({
			store: sqliteStore({ path: join(root, "heypi.db") }),
			logger: consoleLogger({ level: "error", format: "pretty" }),
			state: { root: join(root, "state") },
			http: { port },
			admin: true,
			adapters: [],
			agent: loadAgent("../../examples/slack-devops/agent", { id: "default", model: "openai/gpt-5-mini" }),
			runtime: { name: "host-bash", root: workspace(join(root, "workspace")) },
		});
		await app.start();
		try {
			const response = await fetch(`http://127.0.0.1:${port}/admin`, { redirect: "manual" });
			assert.equal(response.status, 303);
			assert.equal(response.headers.get("location"), "/admin/login");
		} finally {
			await app.stop();
		}
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("createHeypi does not register admin routes by default", async () => {
	const root = await mkdtemp(join(tmpdir(), "heypi-public-api-admin-default-"));
	const port = await freePort();
	try {
		const app = createHeypi({
			store: sqliteStore({ path: join(root, "heypi.db") }),
			state: { root: join(root, "state") },
			logger: consoleLogger({ level: "error", format: "pretty" }),
			http: { port },
			adapters: [
				{
					name: "health",
					kind: "test",
					start: async ({ http }) => {
						http?.register({
							method: "GET",
							path: "/health",
							handler: (_req, res) => {
								res.end("ok");
							},
						});
					},
				},
			],
			agent: loadAgent("../../examples/slack-devops/agent", { id: "default", model: "openai/gpt-5-mini" }),
			runtime: { name: "host-bash", root: workspace(join(root, "workspace")) },
		});
		await app.start();
		try {
			assert.equal(await (await fetch(`http://127.0.0.1:${port}/health`)).text(), "ok");
			const response = await fetch(`http://127.0.0.1:${port}/admin`, { redirect: "manual" });
			assert.equal(response.status, 404);
		} finally {
			await app.stop();
		}
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("createHeypi refuses to start when another app instance holds the lock", async () => {
	const root = await mkdtemp(join(tmpdir(), "heypi-public-api-app-lock-"));
	try {
		const store = sqliteStore({ path: join(root, "heypi.db") });
		await store.setup();
		await store.locks?.acquire({ key: "app:default", owner: "other-process", ttlMs: 60_000 });
		const app = createHeypi({
			store,
			state: { root: join(root, "state") },
			logger: consoleLogger({ level: "error", format: "pretty" }),
			adapters: [{ name: "test", kind: "test", start: async () => undefined }],
			agent: loadAgent("../../examples/slack-devops/agent", { id: "default", model: "openai/gpt-5-mini" }),
			runtime: {
				name: "host-bash",
				root: workspace(join(root, "workspace")),
			},
		});

		await assert.rejects(() => app.start(), /app lock is held/);
		assert.equal((await store.locks?.get("app:default"))?.owner, "other-process");
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("createHeypi clears stale app locks owned by a dead same-host pid", async () => {
	const root = await mkdtemp(join(tmpdir(), "heypi-public-api-stale-app-lock-"));
	try {
		const store = sqliteStore({ path: join(root, "heypi.db") });
		await store.setup();
		await store.locks?.acquire({ key: "app:default", owner: `${hostname()}:2147483647:stale`, ttlMs: 60_000 });
		const app = createHeypi({
			store,
			state: { root: join(root, "state") },
			logger: consoleLogger({ level: "error", format: "pretty" }),
			adapters: [{ name: "test", kind: "test", start: async () => undefined }],
			agent: loadAgent("../../examples/slack-devops/agent", { id: "default", model: "openai/gpt-5-mini" }),
			runtime: {
				name: "host-bash",
				root: workspace(join(root, "workspace")),
			},
		});

		await app.start();
		await app.stop();

		assert.equal(await store.locks?.get("app:default"), undefined);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("createHeypi releases the app lock on stop", async () => {
	const root = await mkdtemp(join(tmpdir(), "heypi-public-api-app-lock-release-"));
	try {
		const store = sqliteStore({ path: join(root, "heypi.db") });
		const app = createHeypi({
			store,
			state: { root: join(root, "state") },
			logger: consoleLogger({ level: "error", format: "pretty" }),
			adapters: [{ name: "test", kind: "test", start: async () => undefined }],
			agent: loadAgent("../../examples/slack-devops/agent", { id: "default", model: "openai/gpt-5-mini" }),
			runtime: {
				name: "host-bash",
				root: workspace(join(root, "workspace")),
			},
		});

		await app.start();
		assert.equal((await store.locks?.get("app:default"))?.key, "app:default");
		await app.stop();

		assert.equal(await store.locks?.get("app:default"), undefined);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("createHeypi stops when app lock refresh loses ownership", async () => {
	const root = await mkdtemp(join(tmpdir(), "heypi-public-api-app-lock-lost-"));
	try {
		const store = sqliteStore({ path: join(root, "heypi.db") });
		let stopped = false;
		const app = createHeypi({
			store,
			state: { root: join(root, "state") },
			logger: consoleLogger({ level: "error", format: "pretty" }),
			adapters: [
				{
					name: "test",
					kind: "test",
					start: async () => undefined,
					stop: async () => {
						stopped = true;
					},
				},
			],
			appLock: { ttlMs: 30, drainMs: 10 },
			agent: loadAgent("../../examples/slack-devops/agent", { id: "default", model: "openai/gpt-5-mini" }),
			runtime: {
				name: "host-bash",
				root: workspace(join(root, "workspace")),
			},
		});

		await app.start();
		const lock = await store.locks?.get("app:default");
		assert.ok(lock);
		await store.locks?.release({ key: "app:default", owner: lock.owner });
		await waitFor(() => stopped);

		assert.equal(stopped, true);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("createHeypi recovers stale running turns and thread locks on startup", async () => {
	const root = await mkdtemp(join(tmpdir(), "heypi-public-api-recovery-"));
	try {
		const store = sqliteStore({ path: join(root, "heypi.db") });
		await store.setup();
		const thread = await store.threads.getOrCreate({
			agent: "default",
			provider: "slack",
			channel: "C1",
			actor: "U1",
			key: "C1:T1",
		});
		const message = await store.messages.create({
			threadId: thread.id,
			provider: "slack",
			role: "user",
			actor: "U1",
			text: "deploy",
		});
		const turn = await store.turns.create({
			threadId: thread.id,
			inputMessageId: message.id,
			agent: "default",
			provider: "slack",
			channel: "C1",
			actor: "U1",
			trace: "trace-stale",
		});
		const call = await store.calls.create({
			agent: "default",
			trace: "trace-stale",
			turnId: turn.id,
			threadId: thread.id,
			channel: "slack::C1",
			actor: "U1",
			tool: "bash",
			command: "sleep 60",
			state: "running",
		});
		await store.jobs?.upsert({
			agent: "default",
			id: "daily",
			kind: "cron",
			schedule: JSON.stringify({ everyMs: 60_000 }),
			prompt: "ping",
			nextAt: Date.now(),
		});
		const jobRun = await store.jobRuns?.create({
			jobAgent: "default",
			jobId: "daily",
			threadId: thread.id,
			trace: "job:default:daily:stale",
		});
		if (!store.jobRuns?.claim) throw new Error("job run claims are required");
		await store.jobRuns.claim({
			agent: "default",
			owner: "dead-process",
			now: Date.now(),
			limit: 1,
		});
		await store.locks?.acquire({ key: `thread:${thread.id}`, owner: "dead-process" });
		const otherThread = await store.threads.getOrCreate({
			agent: "other",
			provider: "slack",
			channel: "C2",
			actor: "U2",
			key: "C2:T2",
		});
		const otherMessage = await store.messages.create({
			threadId: otherThread.id,
			provider: "slack",
			role: "user",
			actor: "U2",
			text: "deploy",
		});
		const otherTurn = await store.turns.create({
			threadId: otherThread.id,
			inputMessageId: otherMessage.id,
			agent: "other",
			provider: "slack",
			channel: "C2",
			actor: "U2",
			trace: "trace-other",
		});
		const otherCall = await store.calls.create({
			agent: "other",
			turnId: otherTurn.id,
			threadId: otherThread.id,
			channel: "slack::C2",
			actor: "U2",
			tool: "bash",
			command: "sleep 60",
			state: "running",
		});
		await store.locks?.acquire({ key: `thread:${otherThread.id}`, owner: "other-process" });

		const adapter: Adapter = { name: "test", kind: "test", start: async () => undefined };
		const app = createHeypi({
			store,
			state: { root: join(root, "state") },
			logger: consoleLogger({ level: "error", format: "pretty" }),
			adapters: [adapter],
			agent: loadAgent("../../examples/slack-devops/agent", { id: "default", model: "openai/gpt-5-mini" }),
			runtime: {
				name: "host-bash",
				root: workspace(join(root, "workspace")),
			},
		});

		await app.start();
		await app.stop();

		const recovered = (await store.turns.listForThread(thread.id)).find((row) => row.id === turn.id);
		assert.equal(recovered?.state, "failed");
		assert.equal((await store.calls.get(call.id))?.state, "failed");
		assert.equal((await store.jobRuns?.lastForJob({ agent: "default", id: "daily" }))?.state, "queued");
		assert.equal(jobRun?.inserted, true);
		assert.equal(await store.locks?.get(`thread:${thread.id}`), undefined);
		assert.deepEqual(
			(await store.events!.list({ agent: "default", trace: "trace-stale" })).map((row) => row.type).sort(),
			["message.sent", "tool.failed", "turn.failed"],
		);
		const other = (await store.turns.listForThread(otherThread.id)).find((row) => row.id === otherTurn.id);
		assert.equal(other?.state, "running");
		assert.equal((await store.calls.get(otherCall.id))?.state, "running");
		assert.equal((await store.locks?.get(`thread:${otherThread.id}`))?.owner, "other-process");
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("createHeypi warns when store recovery capabilities are unsupported", async () => {
	const root = await mkdtemp(join(tmpdir(), "heypi-public-api-recovery-unsupported-"));
	try {
		const store = sqliteStore({ path: join(root, "heypi.db") });
		await store.setup();
		const thread = await store.threads.getOrCreate({
			agent: "default",
			provider: "slack",
			channel: "C1",
			actor: "U1",
			key: "C1:T1",
		});
		const message = await store.messages.create({
			threadId: thread.id,
			provider: "slack",
			role: "user",
			actor: "U1",
			text: "deploy",
		});
		await store.turns.create({
			threadId: thread.id,
			inputMessageId: message.id,
			agent: "default",
			provider: "slack",
			channel: "C1",
			actor: "U1",
			trace: "trace-stale",
		});
		await store.locks?.acquire({ key: `thread:${thread.id}`, owner: "dead-process" });
		store.locks!.clear = undefined;
		store.calls.failRunning = undefined;
		store.jobRuns!.requeueRunning = undefined;
		store.jobRuns!.failRunning = undefined;
		const warnings: Record<string, unknown>[] = [];
		const adapter: Adapter = { name: "test", kind: "test", start: async () => undefined };
		const app = createHeypi({
			store,
			state: { root: join(root, "state") },
			logger: fakeLogger(warnings),
			adapters: [adapter],
			agent: loadAgent("../../examples/slack-devops/agent", { id: "default", model: "openai/gpt-5-mini" }),
			runtime: {
				name: "host-bash",
				root: workspace(join(root, "workspace")),
			},
		});

		await app.start();
		await app.stop();

		assert.deepEqual(
			warnings.map((row) => row.event).filter((event) => String(event).startsWith("app.recovery_")),
			["app.recovery_locks_unsupported", "app.recovery_calls_unsupported", "app.recovery_job_runs_unsupported"],
		);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

async function waitFor(fn: () => boolean): Promise<void> {
	const start = Date.now();
	while (!fn()) {
		if (Date.now() - start > 1_000) throw new Error("condition timed out");
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

async function freePort(): Promise<number> {
	const server = createServer();
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
	if (!address || typeof address === "string") throw new Error("missing port");
	return address.port;
}

function fakeLogger(warnings: Record<string, unknown>[]): Logger {
	return {
		debug: () => undefined,
		info: () => undefined,
		warn: (event, input = {}) => warnings.push({ event, ...input }),
		error: () => undefined,
	};
}

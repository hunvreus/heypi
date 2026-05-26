import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
	type Adapter,
	type AttachmentStore,
	agentFrom,
	commandConfirm,
	consoleLogger,
	coreTools,
	createHeypi,
	runHeypi,
	slack,
	sqliteStore,
	tool,
	workspace,
} from "@hunvreus/heypi";
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
			logger: consoleLogger({ level: "error", format: "pretty" }),
			adapters: [adapter],
			agent: agentFrom("./examples/slack-devops/agent", {
				model: "openai/gpt-5-mini",
				tools: [...coreTools({ bash: { confirm: commandConfirm({ allow: [/^curl -I /] }) } }), lookup],
			}),
			runtime: {
				name: "just-bash",
				root: workspace(join(root, "workspace")),
			},
		});
		assert.equal(typeof app.start, "function");
		assert.equal(typeof app.stop, "function");
		assert.equal(typeof runHeypi, "function");
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("createHeypi defaults to ./heypi.db SQLite store", async () => {
	const root = await mkdtemp(join(tmpdir(), "heypi-public-api-default-store-"));
	const cwd = process.cwd();
	try {
		process.chdir(root);
		const adapter: Adapter = {
			name: "test",
			kind: "test",
			start: async () => undefined,
			stop: async () => undefined,
		};
		const app = createHeypi({
			logger: consoleLogger({ level: "error", format: "pretty" }),
			adapters: [adapter],
			agent: agentFrom(join(cwd, "examples/slack-devops/agent"), { id: "default", model: "openai/gpt-5-mini" }),
			runtime: {
				name: "host-bash",
				root: workspace(join(root, "workspace")),
			},
		});

		await app.start();
		await app.stop();

		assert.equal((await stat(join(root, "heypi.db"))).isFile(), true);
	} finally {
		process.chdir(cwd);
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
			logger: consoleLogger({ level: "error", format: "pretty" }),
			adapters: [adapter],
			attachments: { store: attachments },
			agent: agentFrom("./examples/slack-devops/agent", { id: "default", model: "openai/gpt-5-mini" }),
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
			logger: consoleLogger({ level: "error", format: "pretty" }),
			adapters: [first, second],
			agent: agentFrom("./examples/slack-devops/agent", { id: "default", model: "openai/gpt-5-mini" }),
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
					logger: consoleLogger({ level: "error", format: "pretty" }),
					adapters: [
						{ name: "same", kind: "test", start: async () => undefined },
						{ name: "same", kind: "test", start: async () => undefined },
					],
					agent: agentFrom("./examples/slack-devops/agent", { id: "default", model: "openai/gpt-5-mini" }),
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
						logger: consoleLogger({ level: "error", format: "pretty" }),
						adapters: [{ name: "admin", kind, start: async () => undefined }],
						agent: agentFrom("./examples/slack-devops/agent", { id: "default", model: "openai/gpt-5-mini" }),
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
			http: { port: 0 },
			admin: { auth: false },
			adapters: [{ name: "test", kind: "test", start: async () => undefined }],
			agent: agentFrom("./examples/slack-devops/agent", { id: "default", model: "openai/gpt-5-mini" }),
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
			agent: agentFrom("./examples/slack-devops/agent", { id: "default", model: "openai/gpt-5-mini" }),
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
			agent: agentFrom("./examples/slack-devops/agent", { id: "default", model: "openai/gpt-5-mini" }),
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
			agent: agentFrom("./examples/slack-devops/agent", { id: "default", model: "openai/gpt-5-mini" }),
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
			agent: agentFrom("./examples/slack-devops/agent", { id: "default", model: "openai/gpt-5-mini" }),
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
			http: { port },
			admin: { controlPath: join(root, "admin-control.json") },
			adapters: [],
			agent: agentFrom("./examples/slack-devops/agent", { id: "default", model: "openai/gpt-5-mini" }),
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
			agent: agentFrom("./examples/slack-devops/agent", { id: "default", model: "openai/gpt-5-mini" }),
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
			logger: consoleLogger({ level: "error", format: "pretty" }),
			adapters: [{ name: "test", kind: "test", start: async () => undefined }],
			agent: agentFrom("./examples/slack-devops/agent", { id: "default", model: "openai/gpt-5-mini" }),
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
			logger: consoleLogger({ level: "error", format: "pretty" }),
			adapters: [{ name: "test", kind: "test", start: async () => undefined }],
			agent: agentFrom("./examples/slack-devops/agent", { id: "default", model: "openai/gpt-5-mini" }),
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
			logger: consoleLogger({ level: "error", format: "pretty" }),
			adapters: [{ name: "test", kind: "test", start: async () => undefined }],
			agent: agentFrom("./examples/slack-devops/agent", { id: "default", model: "openai/gpt-5-mini" }),
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
			agent: agentFrom("./examples/slack-devops/agent", { id: "default", model: "openai/gpt-5-mini" }),
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
		await store.locks?.acquire({ key: `thread:${thread.id}`, owner: "dead-process" });

		const adapter: Adapter = { name: "test", kind: "test", start: async () => undefined };
		const app = createHeypi({
			store,
			logger: consoleLogger({ level: "error", format: "pretty" }),
			adapters: [adapter],
			agent: agentFrom("./examples/slack-devops/agent", { id: "default", model: "openai/gpt-5-mini" }),
			runtime: {
				name: "host-bash",
				root: workspace(join(root, "workspace")),
			},
		});

		await app.start();
		await app.stop();

		const recovered = (await store.turns.listForThread(thread.id)).find((row) => row.id === turn.id);
		assert.equal(recovered?.state, "failed");
		assert.equal(await store.locks?.get(`thread:${thread.id}`), undefined);
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

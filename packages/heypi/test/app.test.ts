import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { local } from "../src/adapters.js";
import { loadAgent } from "../src/agent.js";
import { createHeypi } from "../src/app.js";
import type { PiEvent, PiHost, PiHostOptions } from "../src/pi.js";

async function makeDir(name: string): Promise<string> {
	const root = join(tmpdir(), `heypi-${name}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	await mkdir(root, { recursive: true });
	return root;
}

function freePort(): number {
	return 20_000 + Math.floor(Math.random() * 20_000);
}

describe("createHeypi", () => {
	it("routes triggered adapter messages through Pi and replies in the source thread", async () => {
		const root = await makeDir("app-agent");
		const state = await makeDir("app-state");
		const adapter = local();
		const prompts: string[] = [];
		const piOptions: PiHostOptions[] = [];

		const app = await createHeypi({
			agent: loadAgent(root, {
				id: "agent",
				adapters: [adapter],
				state: { dir: state },
				approvals: { enabled: false },
			}),
			piHost(options) {
				piOptions.push(options);
				const listeners: Array<(event: PiEvent) => void> = [];
				const host: PiHost = {
					async start() {},
					async send(text) {
						prompts.push(text);
						for (const listener of listeners) {
							listener({
								type: "message_end",
								message: { role: "assistant", content: "Done." },
							} as unknown as PiEvent);
						}
					},
					subscribe(listener) {
						listeners.push(listener);
						return () => {
							const index = listeners.indexOf(listener);
							if (index >= 0) listeners.splice(index, 1);
						};
					},
					async stop() {},
				};
				return host;
			},
		});

		await app.start();
		await adapter.receive({
			id: "m1",
			user: { id: "u1", name: "Ronan" },
			text: "hello",
		});
		await app.stop();

		expect(prompts).toEqual(["- [uid:u1] Ronan: hello"]);
		expect(adapter.sent).toEqual([{ conversation: "local", thread: "m1", text: "Done." }]);
		expect(piOptions).toHaveLength(1);
		expect(piOptions[0]?.tools).toHaveLength(2);
		expect(piOptions[0]?.extensions).toHaveLength(1);
		expect(piOptions[0]?.agentDir).toBe(join(state, "agents", "agent", "agent"));
	});

	it("can disable the todo extension", async () => {
		const root = await makeDir("app-no-todo-agent");
		const state = await makeDir("app-no-todo-state");
		const adapter = local();
		const piOptions: PiHostOptions[] = [];

		const app = await createHeypi({
			agent: loadAgent(root, {
				id: "agent",
				adapters: [adapter],
				state: { dir: state },
				approvals: { enabled: false },
				todo: { enabled: false },
			}),
			piHost(options) {
				piOptions.push(options);
				return {
					async start() {},
					async send() {},
					subscribe() {
						return () => {};
					},
					async stop() {},
				};
			},
		});

		await app.start();
		await adapter.receive({
			id: "m1",
			user: { id: "u1", name: "Ronan" },
			text: "hello",
		});
		await app.stop();

		expect(piOptions[0]?.extensions).toEqual([]);
	});

	it("does not start Pi for non-triggering adapter messages", async () => {
		const root = await makeDir("app-passive-agent");
		const state = await makeDir("app-passive-state");
		const adapter = local();
		let piStarts = 0;

		const app = await createHeypi({
			agent: loadAgent(root, {
				id: "agent",
				adapters: [adapter],
				state: { dir: state },
				approvals: { enabled: false },
			}),
			piHost() {
				piStarts++;
				const host: PiHost = {
					async start() {},
					async send() {},
					subscribe() {
						return () => {};
					},
					async stop() {},
				};
				return host;
			},
		});

		await app.start();
		await adapter.receive({
			id: "m1",
			user: { id: "u1", name: "Ronan" },
			text: "ambient channel message",
			mentioned: false,
			dm: false,
		});
		await app.stop();

		expect(piStarts).toBe(0);
		expect(adapter.sent).toEqual([]);
	});

	it("does not send blank final replies when Pi produces no assistant text", async () => {
		const root = await makeDir("app-empty-agent");
		const state = await makeDir("app-empty-state");
		const adapter = local();

		const app = await createHeypi({
			agent: loadAgent(root, {
				id: "agent",
				adapters: [adapter],
				state: { dir: state },
				approvals: { enabled: false },
			}),
			piHost() {
				const host: PiHost = {
					async start() {},
					async send() {},
					subscribe() {
						return () => {};
					},
					async stop() {},
				};
				return host;
			},
		});

		await app.start();
		await adapter.receive({
			id: "m1",
			user: { id: "u1", name: "Ronan" },
			text: "hello",
		});
		await app.stop();

		expect(adapter.sent).toEqual([]);
	});

	it("reports Pi startup failures to the source thread", async () => {
		const root = await makeDir("app-start-fail-agent");
		const state = await makeDir("app-start-fail-state");
		const adapter = local();

		const app = await createHeypi({
			agent: loadAgent(root, {
				id: "agent",
				adapters: [adapter],
				state: { dir: state },
				approvals: { enabled: false },
			}),
			piHost() {
				return {
					async start() {
						throw new Error("Pi unavailable");
					},
					async send() {},
					subscribe() {
						return () => {};
					},
					async stop() {},
				};
			},
		});

		await app.start();
		await adapter.receive({
			id: "m1",
			user: { id: "u1", name: "Ronan" },
			text: "hello",
		});
		await app.stop();

		expect(adapter.sent).toEqual([{ conversation: "local", thread: "m1", text: "The agent failed: Pi unavailable" }]);
	});

	it("continues processing when adapter ack fails", async () => {
		const root = await makeDir("app-ack-fail-agent");
		const state = await makeDir("app-ack-fail-state");
		const adapter = local();
		adapter.ack = async () => {
			throw new Error("reaction failed");
		};
		const warnings: string[] = [];

		const app = await createHeypi({
			agent: loadAgent(root, {
				id: "agent",
				adapters: [adapter],
				state: { dir: state },
				approvals: { enabled: false },
			}),
			logger: {
				debug() {},
				info() {},
				warn(event) {
					warnings.push(event);
				},
				error() {},
			},
			piHost() {
				const listeners: Array<(event: PiEvent) => void> = [];
				return {
					async start() {},
					async send() {
						for (const listener of listeners) {
							listener({
								type: "message_end",
								message: { role: "assistant", content: "Still done." },
							} as unknown as PiEvent);
						}
					},
					subscribe(listener) {
						listeners.push(listener);
						return () => {};
					},
					async stop() {},
				};
			},
		});

		await app.start();
		await adapter.receive({
			id: "m1",
			user: { id: "u1", name: "Ronan" },
			text: "hello",
		});
		await app.stop();

		expect(warnings).toEqual(["adapter.ack_failed"]);
		expect(adapter.sent).toEqual([{ conversation: "local", thread: "m1", text: "Still done." }]);
	});

	it("does not send replies after stop begins", async () => {
		const root = await makeDir("app-stop-agent");
		const state = await makeDir("app-stop-state");
		const adapter = local();
		let releaseSend: (() => void) | undefined;
		let markSendStarted: (() => void) | undefined;
		const sendStarted = new Promise<void>((resolve) => {
			markSendStarted = resolve;
		});
		let stops = 0;

		const app = await createHeypi({
			agent: loadAgent(root, {
				id: "agent",
				adapters: [adapter],
				state: { dir: state },
				approvals: { enabled: false },
			}),
			piHost() {
				const listeners: Array<(event: PiEvent) => void> = [];
				return {
					async start() {},
					async send() {
						markSendStarted?.();
						await new Promise<void>((resolve) => {
							releaseSend = resolve;
						});
						for (const listener of listeners) {
							listener({
								type: "message_end",
								message: { role: "assistant", content: "Late reply." },
							} as unknown as PiEvent);
						}
					},
					subscribe(listener) {
						listeners.push(listener);
						return () => {};
					},
					async stop() {
						stops++;
					},
				};
			},
		});

		await app.start();
		const receive = adapter.receive({
			id: "m1",
			user: { id: "u1", name: "Ronan" },
			text: "hello",
		});
		await sendStarted;
		await app.stop();
		releaseSend?.();
		await receive;

		expect(stops).toBe(1);
		expect(adapter.sent).toEqual([]);
	});

	it("starts and stops the optional admin server", async () => {
		const root = await makeDir("app-admin-agent");
		const state = await makeDir("app-admin-state");
		const adapter = local();
		const port = freePort();

		const app = await createHeypi({
			agent: loadAgent(root, {
				id: "agent",
				adapters: [adapter],
				state: { dir: state },
				admin: { enabled: true, port },
				approvals: { enabled: false },
			}),
			piHost() {
				return {
					async start() {},
					async send() {},
					subscribe() {
						return () => {};
					},
					async stop() {},
				};
			},
		});

		await app.start();
		await expect(fetch(`http://127.0.0.1:${port}/admin/health`).then((response) => response.json())).resolves.toEqual(
			{
				ok: true,
			},
		);
		await app.stop();
		await expect(fetch(`http://127.0.0.1:${port}/admin/health`)).rejects.toThrow();
	});

	it("serializes concurrent first messages onto one channel session", async () => {
		const root = await makeDir("app-concurrent-agent");
		const state = await makeDir("app-concurrent-state");
		const adapter = local();
		let piStarts = 0;

		const app = await createHeypi({
			agent: loadAgent(root, {
				id: "agent",
				adapters: [adapter],
				state: { dir: state },
				approvals: { enabled: false },
			}),
			piHost() {
				piStarts++;
				const listeners: Array<(event: PiEvent) => void> = [];
				return {
					async start() {},
					async send() {
						for (const listener of listeners) {
							listener({
								type: "message_end",
								message: { role: "assistant", content: "Done." },
							} as unknown as PiEvent);
						}
					},
					subscribe(listener) {
						listeners.push(listener);
						return () => {};
					},
					async stop() {},
				};
			},
		});

		await app.start();
		await Promise.all([
			adapter.receive({
				id: "m1",
				user: { id: "u1", name: "Ronan" },
				text: "first",
			}),
			adapter.receive({
				id: "m2",
				user: { id: "u1", name: "Ronan" },
				text: "second",
			}),
		]);
		await app.stop();

		expect(piStarts).toBe(1);
		expect(adapter.sent).toHaveLength(2);
		expect(adapter.sent).toContainEqual({ conversation: "local", thread: "m1", text: "Done." });
		expect(adapter.sent).toContainEqual({ conversation: "local", thread: "m2", text: "Done." });
	});
});

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
	it("emits a human-readable ready hook after startup", async () => {
		const root = await makeDir("app-ready-agent");
		const state = await makeDir("app-ready-state");
		const adapter = local("local-dev");
		const ready: unknown[] = [];

		const app = await createHeypi({
			adapters: [adapter],
			agent: loadAgent(root, {
				id: "agent",
				state: { dir: state },
				admin: { port: freePort() },
			}),
			logger: {
				debug() {},
				info() {},
				warn() {},
				error() {},
				ready(info) {
					ready.push(info);
				},
			},
		});

		await app.start();
		await app.stop();

		expect(ready).toEqual([
			{
				agent: "agent",
				adapters: ["local-dev"],
				admin: expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+\/admin$/),
			},
		]);
	});

	it("routes triggered adapter messages through Pi and replies in the source thread", async () => {
		const root = await makeDir("app-agent");
		const state = await makeDir("app-state");
		const adapter = local();
		const prompts: string[] = [];
		const piOptions: PiHostOptions[] = [];

		const app = await createHeypi({
			adapters: [adapter],
			agent: loadAgent(root, {
				id: "agent",
				state: { dir: state },
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
		expect(adapter.sent).toEqual([{ conversation: "local", thread: undefined, text: "Done." }]);
		expect(piOptions).toHaveLength(1);
		expect(piOptions[0]?.customTools).toHaveLength(1);
		expect(piOptions[0]?.extensions).toHaveLength(2);
		expect(piOptions[0]?.agentDir).toBe(join(state, "agents", "agent", "agent"));
	});

	it("sends adapter-owned progress from Pi runtime events", async () => {
		const root = await makeDir("app-progress-agent");
		const state = await makeDir("app-progress-state");
		const adapter = local();
		const updates: string[] = [];
		const logs: Array<{ event: string; data?: Record<string, unknown> }> = [];
		const update = adapter.update?.bind(adapter);
		adapter.update = async (message) => {
			updates.push(message.text);
			await update?.(message);
		};

		const app = await createHeypi({
			adapters: [adapter],
			agent: loadAgent(root, {
				id: "agent",
				state: { dir: state },
			}),
			logger: {
				debug(event, data) {
					logs.push({ event, data });
				},
				info(event, data) {
					logs.push({ event, data });
				},
				warn(event, data) {
					logs.push({ event, data });
				},
				error(event, data) {
					logs.push({ event, data });
				},
			},
			piHost() {
				const listeners: Array<(event: PiEvent) => void> = [];
				return {
					async start() {},
					async send() {
						for (const listener of listeners) {
							listener({ type: "turn_start" } as unknown as PiEvent);
							listener({ type: "tool_execution_start", toolName: "bash" } as unknown as PiEvent);
							listener({ type: "compaction_start" } as unknown as PiEvent);
							listener({ type: "auto_retry_start", attempt: 1, maxAttempts: 3 } as unknown as PiEvent);
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
		await adapter.receive({
			id: "m1",
			user: { id: "u1", name: "Ronan" },
			text: "hello",
		});
		await app.stop();

		expect(adapter.sent).toEqual([
			{ conversation: "local", thread: undefined, text: "Done.", attachments: undefined },
		]);
		expect(updates).toEqual(["Working...", "Done."]);
		expect(logs).toContainEqual({
			event: "pi.tool.start",
			data: { adapter: "local", conversation: "local", thread: undefined, tool: "bash" },
		});
	});

	it("falls back to a new final reply when progress replacement fails", async () => {
		const root = await makeDir("app-progress-final-fallback-agent");
		const state = await makeDir("app-progress-final-fallback-state");
		const adapter = local();
		adapter.update = async () => {
			throw new Error("cannot edit");
		};

		const app = await createHeypi({
			adapters: [adapter],
			agent: loadAgent(root, {
				id: "agent",
				state: { dir: state },
			}),
			piHost() {
				const listeners: Array<(event: PiEvent) => void> = [];
				return {
					async start() {},
					async send() {
						for (const listener of listeners) {
							listener({ type: "turn_start" } as unknown as PiEvent);
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
		await adapter.receive({
			id: "m1",
			user: { id: "u1", name: "Ronan" },
			text: "hello",
		});
		await app.stop();

		expect(adapter.sent).toEqual([
			{ conversation: "local", thread: undefined, text: "Thinking..." },
			{ conversation: "local", thread: undefined, text: "Done." },
		]);
	});

	it("does not repeat progress messages when an editable adapter returns no message id", async () => {
		const root = await makeDir("app-progress-no-id-agent");
		const state = await makeDir("app-progress-no-id-state");
		const adapter = local();
		adapter.send = async (message) => {
			adapter.sent.push(message);
			return {};
		};

		const app = await createHeypi({
			adapters: [adapter],
			agent: loadAgent(root, {
				id: "agent",
				state: { dir: state },
			}),
			piHost() {
				const listeners: Array<(event: PiEvent) => void> = [];
				return {
					async start() {},
					async send() {
						for (const listener of listeners) {
							listener({ type: "turn_start" } as unknown as PiEvent);
							listener({ type: "tool_execution_start", toolName: "bash" } as unknown as PiEvent);
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
		await adapter.receive({
			id: "m1",
			user: { id: "u1", name: "Ronan" },
			text: "hello",
		});
		await app.stop();

		expect(adapter.sent).toEqual([
			{ conversation: "local", thread: undefined, text: "Thinking..." },
			{ conversation: "local", thread: undefined, text: "Done." },
		]);
	});

	it("replaces progress with an error when Pi fails", async () => {
		const root = await makeDir("app-progress-error-agent");
		const state = await makeDir("app-progress-error-state");
		const adapter = local();

		const app = await createHeypi({
			adapters: [adapter],
			agent: loadAgent(root, {
				id: "agent",
				state: { dir: state },
			}),
			piHost() {
				const listeners: Array<(event: PiEvent) => void> = [];
				return {
					async start() {},
					async send() {
						for (const listener of listeners) listener({ type: "turn_start" } as unknown as PiEvent);
						throw new Error("model unavailable");
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

		expect(adapter.sent).toEqual([
			{
				conversation: "local",
				thread: undefined,
				text: "The agent failed: model unavailable",
				attachments: undefined,
			},
		]);
	});

	it("can disable adapter-owned progress", async () => {
		const root = await makeDir("app-no-progress-agent");
		const state = await makeDir("app-no-progress-state");
		const adapter = local({ progress: false });

		const app = await createHeypi({
			adapters: [adapter],
			agent: loadAgent(root, {
				id: "agent",
				state: { dir: state },
			}),
			piHost() {
				const listeners: Array<(event: PiEvent) => void> = [];
				return {
					async start() {},
					async send() {
						for (const listener of listeners) {
							listener({ type: "turn_start" } as unknown as PiEvent);
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
		await adapter.receive({
			id: "m1",
			user: { id: "u1", name: "Ronan" },
			text: "hello",
		});
		await app.stop();

		expect(adapter.sent).toEqual([{ conversation: "local", thread: undefined, text: "Done." }]);
	});

	it("does not start Pi for non-triggering adapter messages", async () => {
		const root = await makeDir("app-passive-agent");
		const state = await makeDir("app-passive-state");
		const adapter = local();
		let piStarts = 0;

		const app = await createHeypi({
			adapters: [adapter],
			agent: loadAgent(root, {
				id: "agent",
				state: { dir: state },
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

	it("does not acknowledge or start Pi for self-authored adapter messages", async () => {
		const root = await makeDir("app-bot-message-agent");
		const state = await makeDir("app-bot-message-state");
		const adapter = local();
		let acks = 0;
		let piStarts = 0;
		adapter.ack = () => {
			acks++;
		};

		const app = await createHeypi({
			adapters: [adapter],
			agent: loadAgent(root, {
				id: "agent",
				state: { dir: state },
			}),
			piHost() {
				piStarts++;
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
			user: { id: "bot", name: "Bot", isBot: true, isSelf: true },
			text: "self reply",
		});
		await app.stop();

		expect(acks).toBe(0);
		expect(piStarts).toBe(0);
		expect(adapter.sent).toEqual([]);
	});

	it("does not acknowledge or start Pi for bot-authored messages unless bots are allowed", async () => {
		const root = await makeDir("app-other-bot-denied-agent");
		const state = await makeDir("app-other-bot-denied-state");
		const adapter = local();
		let acks = 0;
		let piStarts = 0;
		adapter.ack = () => {
			acks++;
		};

		const app = await createHeypi({
			adapters: [adapter],
			agent: loadAgent(root, {
				id: "agent",
				state: { dir: state },
			}),
			piHost() {
				piStarts++;
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
			user: { id: "bot-1", name: "Other bot", isBot: true },
			text: "bot request",
		});
		await app.stop();

		expect(acks).toBe(0);
		expect(piStarts).toBe(0);
		expect(adapter.sent).toEqual([]);
	});

	it("can allow bot-authored messages without including older bot history", async () => {
		const root = await makeDir("app-other-bot-allowed-agent");
		const state = await makeDir("app-other-bot-allowed-state");
		const adapter = local({ allow: { bots: ["bot-1"] } });
		const prompts: string[] = [];

		const app = await createHeypi({
			adapters: [adapter],
			agent: loadAgent(root, {
				id: "agent",
				state: { dir: state },
			}),
			piHost() {
				const listeners: Array<(event: PiEvent) => void> = [];
				return {
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
						return () => {};
					},
					async stop() {},
				};
			},
		});

		await app.start();
		await adapter.receive({
			id: "m1",
			user: { id: "bot-2", name: "Denied bot", isBot: true },
			text: "previous bot request",
		});
		await adapter.receive({
			id: "m2",
			user: { id: "bot-1", name: "Allowed bot", isBot: true },
			text: "allowed bot request",
		});
		await app.stop();

		expect(prompts).toEqual(["- [uid:bot-1] Allowed bot: allowed bot request"]);
		expect(adapter.sent).toEqual([{ conversation: "local", thread: undefined, text: "Done." }]);
	});

	it("does not acknowledge or start Pi for messages outside the allowlist", async () => {
		const root = await makeDir("app-denied-agent");
		const state = await makeDir("app-denied-state");
		const adapter = local({ allow: { users: ["u2"] } });
		let acks = 0;
		let piStarts = 0;
		const warnings: string[] = [];
		adapter.ack = () => {
			acks++;
		};

		const app = await createHeypi({
			adapters: [adapter],
			agent: loadAgent(root, {
				id: "agent",
				state: { dir: state },
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
				piStarts++;
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

		expect(acks).toBe(0);
		expect(piStarts).toBe(0);
		expect(warnings).toEqual(["adapter.message_denied"]);
		expect(adapter.sent).toEqual([]);
	});

	it("does not send blank final replies when Pi produces no assistant text", async () => {
		const root = await makeDir("app-empty-agent");
		const state = await makeDir("app-empty-state");
		const adapter = local();

		const app = await createHeypi({
			adapters: [adapter],
			agent: loadAgent(root, {
				id: "agent",
				state: { dir: state },
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
			adapters: [adapter],
			agent: loadAgent(root, {
				id: "agent",
				state: { dir: state },
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

		expect(adapter.sent).toEqual([
			{ conversation: "local", thread: undefined, text: "The agent failed: Pi unavailable" },
		]);
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
			adapters: [adapter],
			agent: loadAgent(root, {
				id: "agent",
				state: { dir: state },
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
		expect(adapter.sent).toEqual([{ conversation: "local", thread: undefined, text: "Still done." }]);
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
			adapters: [adapter],
			agent: loadAgent(root, {
				id: "agent",
				state: { dir: state },
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
			adapters: [adapter],
			agent: loadAgent(root, {
				id: "agent",
				state: { dir: state },
				admin: { port },
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
			adapters: [adapter],
			agent: loadAgent(root, {
				id: "agent",
				state: { dir: state },
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
		expect(adapter.sent).toContainEqual({ conversation: "local", thread: undefined, text: "Done." });
		expect(adapter.sent).toContainEqual({ conversation: "local", thread: undefined, text: "Done." });
	});
});

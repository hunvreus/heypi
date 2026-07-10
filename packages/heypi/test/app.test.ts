import { constants, createCipheriv, createPublicKey, publicEncrypt, randomBytes } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
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

function encryptedReply(widgetUrl: string, value: string): string {
	const payload = JSON.parse(Buffer.from(widgetUrl.split("#")[1] ?? "", "base64").toString("utf8")) as {
		k: string;
		r: string;
	};
	const key = randomBytes(32);
	const iv = randomBytes(12);
	const cipher = createCipheriv("aes-256-gcm", key, iv);
	const ciphertext = Buffer.concat([cipher.update(value), cipher.final()]);
	const tag = cipher.getAuthTag();
	const publicKey = createPublicKey({ key: Buffer.from(payload.k, "base64"), type: "spki", format: "der" });
	const encryptedKey = publicEncrypt(
		{ key: publicKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" },
		key,
	);
	const length = Buffer.alloc(2);
	length.writeUInt16BE(encryptedKey.length, 0);
	const encrypted = Buffer.concat([length, encryptedKey, iv, ciphertext, tag]).toString("base64");
	return `!secret:${payload.r}:${encrypted}`;
}

type PiListener = (event: PiEvent) => void;
type TestTool = {
	name: string;
	execute(
		toolCallId: string,
		params: unknown,
		signal?: AbortSignal,
		context?: unknown,
		extra?: unknown,
	): Promise<unknown>;
};

function emitAssistant(listeners: PiListener[], content: string): void {
	for (const listener of listeners) {
		listener({
			type: "message_end",
			message: { role: "assistant", content },
		} as unknown as PiEvent);
	}
}

function replyHost(content = "Done.", onSend?: (text: string) => Promise<void> | void): PiHost {
	const listeners: PiListener[] = [];
	return {
		async start() {},
		async send(text) {
			await onSend?.(text);
			emitAssistant(listeners, content);
		},
		subscribe(listener) {
			listeners.push(listener);
			return () => {};
		},
		async stop() {},
	};
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
				return replyHost("Done.", (text) => {
					prompts.push(text);
				});
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
		expect(piOptions[0]?.customTools).toHaveLength(3);
		expect(piOptions[0]?.extensions).toHaveLength(2);
		expect(piOptions[0]?.agentDir).toBe(join(state, "agents", "agent", "agent"));
	});

	it("stores encrypted chat secrets without exposing the value or encrypted reply to Pi", async () => {
		const root = await makeDir("app-secret-agent");
		const state = await makeDir("app-secret-state");
		const workspace = await makeDir("app-secret-workspace");
		const adapter = local();
		const prompts: string[] = [];

		const app = await createHeypi({
			adapters: [adapter],
			agent: loadAgent(root, {
				id: "agent",
				state: { dir: state },
				runtime: { kind: "host", workspace },
			}),
			piHost(options) {
				const listeners: Array<(event: PiEvent) => void> = [];
				return {
					async start() {},
					async send(text) {
						prompts.push(text);
						if (prompts.length === 1) {
							const secretTool = options.customTools.find((tool) => tool.name === "chat_request_secret") as
								| TestTool
								| undefined;
							await secretTool?.execute(
								"call",
								{ name: "github-token", description: "GitHub token for PR work" },
								undefined,
								undefined,
								{},
							);
							for (const listener of listeners) {
								listener({
									type: "message_end",
									message: { role: "assistant", content: "Waiting for the secret." },
								} as unknown as PiEvent);
							}
							return;
						}
						for (const listener of listeners) {
							listener({
								type: "message_end",
								message: { role: "assistant", content: "Secret is available." },
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
			text: "I need GitHub auth",
		});
		const requestText = adapter.sent.find((message) => message.text.includes("https://pi.dev/secret#"))?.text;
		expect(requestText).toBeTruthy();
		const secretReply = encryptedReply(requestText ?? "", "ghp_secret");
		await adapter.receive({
			id: "m2",
			user: { id: "u1", name: "Ronan" },
			text: secretReply,
		});
		await app.stop();

		await expect(readFile(join(workspace, ".secrets", "github-token"), "utf8")).resolves.toBe("ghp_secret");
		expect(prompts).toEqual([
			"- [uid:u1] Ronan: I need GitHub auth",
			"- [uid:u1] Ronan: [secret stored: github-token at .secrets/github-token]",
		]);
		expect(prompts.join("\n")).not.toContain(secretReply);
		expect(prompts.join("\n")).not.toContain("ghp_secret");
		expect(adapter.sent).toContainEqual({
			conversation: "local",
			thread: undefined,
			text: "Secret received and stored as .secrets/github-token.",
		});
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
				const listeners: PiListener[] = [];
				return {
					async start() {},
					async send() {
						for (const listener of listeners) {
							listener({ type: "turn_start" } as unknown as PiEvent);
							listener({ type: "tool_execution_start", toolName: "bash" } as unknown as PiEvent);
							listener({
								type: "tool_execution_end",
								toolName: "bash",
								isError: false,
							} as unknown as PiEvent);
							listener({ type: "compaction_start" } as unknown as PiEvent);
							listener({ type: "auto_retry_start", attempt: 1, maxAttempts: 3 } as unknown as PiEvent);
						}
						emitAssistant(listeners, "Done.");
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
		expect(logs).toContainEqual({
			event: "pi.tool.end",
			data: { adapter: "local", conversation: "local", thread: undefined, tool: "bash" },
		});
	});

	it("logs failed Pi tool executions", async () => {
		const root = await makeDir("app-tool-error-agent");
		const state = await makeDir("app-tool-error-state");
		const adapter = local();
		const logs: Array<{ event: string; data?: Record<string, unknown> }> = [];

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
				const listeners: PiListener[] = [];
				return {
					async start() {},
					async send() {
						for (const listener of listeners) {
							listener({ type: "tool_execution_start", toolName: "bash" } as unknown as PiEvent);
							listener({
								type: "tool_execution_end",
								toolName: "bash",
								isError: true,
							} as unknown as PiEvent);
						}
						emitAssistant(listeners, "Handled.");
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

		expect(logs).toContainEqual({
			event: "pi.tool.error",
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
				const listeners: PiListener[] = [];
				return {
					async start() {},
					async send() {
						for (const listener of listeners) {
							listener({ type: "turn_start" } as unknown as PiEvent);
						}
						emitAssistant(listeners, "Done.");
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
				const listeners: PiListener[] = [];
				return {
					async start() {},
					async send() {
						for (const listener of listeners) {
							listener({ type: "turn_start" } as unknown as PiEvent);
							listener({ type: "tool_execution_start", toolName: "bash" } as unknown as PiEvent);
						}
						emitAssistant(listeners, "Done.");
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
				const listeners: PiListener[] = [];
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
		const adapter = local();

		const app = await createHeypi({
			adapters: [adapter],
			agent: loadAgent(root, {
				id: "agent",
				state: { dir: state },
			}),
			piHost() {
				const listeners: PiListener[] = [];
				return {
					async start() {},
					async send() {
						for (const listener of listeners) {
							listener({ type: "turn_start" } as unknown as PiEvent);
						}
						emitAssistant(listeners, "Done.");
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

	it("lets adapters override default event progress handlers", async () => {
		const root = await makeDir("app-event-override-agent");
		const state = await makeDir("app-event-override-state");
		const adapter = local({
			events: {
				"turn.started": (_event, context) => {
					context.status.replace("Starting custom handler...");
				},
				"tool.started": false,
			},
		});
		const updates: string[] = [];
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
			piHost() {
				const listeners: PiListener[] = [];
				return {
					async start() {},
					async send() {
						for (const listener of listeners) {
							listener({ type: "tool_execution_start", toolName: "bash" } as unknown as PiEvent);
						}
						emitAssistant(listeners, "Done.");
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

		expect(updates).toEqual(["Done."]);
		expect(adapter.sent).toEqual([
			{ conversation: "local", thread: undefined, text: "Done.", attachments: undefined },
		]);
	});

	it("emits accepted-message adapter events before dispatch", async () => {
		const root = await makeDir("app-event-accepted-agent");
		const state = await makeDir("app-event-accepted-state");
		const accepted: string[] = [];
		const adapter = local({
			events: {
				"message.accepted": (event) => {
					accepted.push(event.message.text);
				},
			},
			progress: false,
		});

		const app = await createHeypi({
			adapters: [adapter],
			agent: loadAgent(root, {
				id: "agent",
				state: { dir: state },
			}),
			piHost() {
				return replyHost();
			},
		});

		await app.start();
		await adapter.receive({
			id: "m1",
			user: { id: "u1", name: "Ronan" },
			text: "hello",
		});
		await app.stop();

		expect(accepted).toEqual(["hello"]);
	});

	it("exposes running and queued jobs and can cancel queued jobs", async () => {
		const root = await makeDir("app-jobs-agent");
		const state = await makeDir("app-jobs-state");
		const adapter = local();
		let releaseSend: (() => void) | undefined;
		let resolveSendStarted: (() => void) | undefined;
		const sendStarted = new Promise<void>((resolve) => {
			resolveSendStarted = resolve;
		});
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
						resolveSendStarted?.();
						await new Promise<void>((release) => {
							releaseSend = release;
						});
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
		const first = adapter.receive({
			id: "m1",
			user: { id: "u1", name: "Ronan" },
			text: "first",
		});
		await sendStarted;
		await adapter.receive({
			id: "m2",
			user: { id: "u1", name: "Ronan" },
			text: "second",
		});

		expect(app.jobs().map((job) => job.state)).toEqual(["running", "queued"]);
		await expect(app.cancelQueued("user canceled")).resolves.toBe(1);
		expect(app.jobs().map((job) => job.state)).toEqual(["running"]);

		releaseSend?.();
		await first;
		await app.stop();
	});

	it("can abort the active Pi turn", async () => {
		const root = await makeDir("app-cancel-active-agent");
		const state = await makeDir("app-cancel-active-state");
		const adapter = local();
		let rejectSend: ((error: Error) => void) | undefined;
		let resolveSendStarted: (() => void) | undefined;
		let aborts = 0;
		const sendStarted = new Promise<void>((resolve) => {
			resolveSendStarted = resolve;
		});
		const app = await createHeypi({
			adapters: [adapter],
			agent: loadAgent(root, {
				id: "agent",
				state: { dir: state },
			}),
			piHost() {
				return {
					async start() {},
					async send() {
						resolveSendStarted?.();
						await new Promise<void>((_resolve, reject) => {
							rejectSend = reject;
						});
					},
					async abort() {
						aborts += 1;
						rejectSend?.(new Error("aborted"));
					},
					subscribe() {
						return () => {};
					},
					async stop() {},
				};
			},
		});

		await app.start();
		const turn = adapter.receive({
			id: "m1",
			user: { id: "u1", name: "Ronan" },
			text: "first",
		});
		await sendStarted;

		await expect(app.cancelActive("user canceled")).resolves.toBe(1);
		await turn;

		expect(aborts).toBe(1);
		expect(app.jobs()).toEqual([]);
		expect(adapter.sent).toEqual([{ conversation: "local", thread: undefined, text: "Canceled: user canceled" }]);
		await app.stop();
	});

	it("settles todo updates when the turn completes", async () => {
		const root = await makeDir("app-todo-agent");
		const state = await makeDir("app-todo-state");
		const adapter = local();

		const app = await createHeypi({
			adapters: [adapter],
			agent: loadAgent(root, {
				id: "agent",
				state: { dir: state },
			}),
			piHost(options) {
				type Tool = {
					name: string;
					execute(toolCallId: string, params: unknown, signal?: AbortSignal): Promise<unknown>;
				};
				let todo: Tool | undefined;
				const listeners: Array<(event: PiEvent) => void> = [];
				return {
					async start() {
						for (const extension of options.extensions ?? []) {
							extension({
								registerTool(tool: Tool) {
									if (tool.name === "todo") todo = tool;
								},
							} as never);
						}
					},
					async send() {
						await todo?.execute("call", { action: "plan", items: ["Inspect repo", "Patch bug"], start: 1 });
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
			user: { id: "u1", name: "Ronan" },
			text: "hello",
		});
		await app.stop();

		expect(adapter.sent).toEqual([
			{ conversation: "local", thread: undefined, text: ["✓ Inspect repo", "○ Patch bug"].join("\n") },
			{ conversation: "local", thread: undefined, text: "Done." },
		]);
	});

	it("can disable the built-in todo tool", async () => {
		const root = await makeDir("app-todo-disabled-agent");
		const state = await makeDir("app-todo-disabled-state");
		const adapter = local();
		const piOptions: PiHostOptions[] = [];

		const app = await createHeypi({
			adapters: [adapter],
			agent: loadAgent(root, {
				id: "agent",
				state: { dir: state },
				todo: false,
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

		expect(piOptions[0]?.extensions).toHaveLength(1);
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
				return replyHost("Done.", (text) => {
					prompts.push(text);
				});
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

		expect(adapter.sent).toEqual([
			{ conversation: "local", thread: undefined, text: "Done.", attachments: undefined },
		]);
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
				return replyHost("Still done.");
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
		expect(adapter.sent).toEqual([{ conversation: "local", thread: undefined, text: "Thinking..." }]);
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
				return replyHost();
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

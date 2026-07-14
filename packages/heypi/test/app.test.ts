import { constants, createCipheriv, publicEncrypt, randomBytes } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { local } from "../src/adapters.js";
import { loadAgent } from "../src/agent.js";
import { createHeypi } from "../src/app.js";
import { approval } from "../src/approval.js";
import type { PiEvent, PiHost, PiHostOptions } from "../src/pi.js";

async function makeDir(name: string): Promise<string> {
	const root = join(tmpdir(), `heypi-${name}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	await mkdir(root, { recursive: true });
	return root;
}

function freePort(): number {
	return 20_000 + Math.floor(Math.random() * 20_000);
}

type PiListener = (event: PiEvent) => void;

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
		async steer() {},
		subscribe(listener) {
			listeners.push(listener);
			return () => {};
		},
		async stop() {},
	};
}

function encryptedSecretReply(url: string, secret: string): string {
	const hash = new URL(url).hash.slice(1);
	const request = JSON.parse(Buffer.from(hash, "base64url").toString("utf8")) as { r: string; k: string };
	const key = randomBytes(32);
	const iv = randomBytes(12);
	const cipher = createCipheriv("aes-256-gcm", key, iv);
	const encrypted = Buffer.concat([cipher.update(secret, "utf8"), cipher.final(), cipher.getAuthTag()]);
	const encryptedKey = publicEncrypt(
		{
			key: Buffer.from(request.k, "base64"),
			format: "der",
			type: "spki",
			padding: constants.RSA_PKCS1_OAEP_PADDING,
			oaepHash: "sha256",
		},
		key,
	);
	const body = Buffer.alloc(2 + encryptedKey.length + iv.length + encrypted.length);
	body.writeUInt16BE(encryptedKey.length, 0);
	encryptedKey.copy(body, 2);
	iv.copy(body, 2 + encryptedKey.length);
	encrypted.copy(body, 2 + encryptedKey.length + iv.length);
	return `!secret:${request.r}:${body.toString("base64")}`;
}

describe("createHeypi", () => {
	it("starts with tool approvals even when adapters do not restrict approvers", async () => {
		const root = await makeDir("app-open-approval-agent");
		const state = await makeDir("app-open-approval-state");
		const app = await createHeypi({
			adapters: [local({ progress: false })],
			agent: loadAgent(root, {
				id: "agent",
				state: { dir: state },
				tools: {
					bash: { approve: approval.command() },
				},
			}),
			piHost() {
				return replyHost("ready");
			},
		});

		await expect(app.start()).resolves.toBeUndefined();
		await app.stop();
	});

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

	it("intercepts encrypted secret replies before they reach Pi", async () => {
		const root = await makeDir("app-secret-agent");
		const state = await makeDir("app-secret-state");
		const adapter = local({ progress: false });
		let sends = 0;
		let secretUrl: string | undefined;

		const app = await createHeypi({
			adapters: [adapter],
			agent: loadAgent(root, {
				id: "agent",
				state: { dir: state },
			}),
			piHost(options) {
				return {
					async start() {},
					async send() {
						sends++;
						const tool = options.customTools.find((tool) => tool.name === "chat_request_secret");
						await tool?.execute(
							"call",
							{ name: "github-token", description: "GitHub token" },
							undefined,
							undefined,
							{} as never,
						);
						secretUrl = String(adapter.sent.at(-1)?.text.match(/https:\/\/\S+/)?.[0]);
						emitAssistant([], "Waiting for secret.");
					},
					subscribe() {
						return () => {};
					},
					async stop() {},
				};
			},
		});

		await app.start();
		await adapter.receive({ id: "m1", user: { id: "u1", name: "Ronan" }, text: "need a token" });
		expect(secretUrl).toContain("https://heypi.dev/secret#");

		await adapter.receive({
			id: "m2",
			user: { id: "u1", name: "Ronan" },
			text: encryptedSecretReply(secretUrl!, "ghp_test"),
		});
		await app.stop();

		expect(sends).toBe(1);
		expect(adapter.sent.at(-1)).toEqual({
			conversation: "local",
			thread: undefined,
			text: "Secret received and stored as github-token.",
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
		expect(updates).toEqual(["Working..."]);
		expect(logs).toContainEqual({
			event: "pi.tool.start",
			data: { adapter: "local", conversation: "local", thread: undefined, tool: "bash" },
		});
		expect(logs).toContainEqual({
			event: "pi.tool.end",
			data: { adapter: "local", conversation: "local", thread: undefined, tool: "bash" },
		});
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

	it("supports in-chat status and stop controls for the active actor", async () => {
		const root = await makeDir("app-chat-controls-agent");
		const state = await makeDir("app-chat-controls-state");
		const adapter = local({ progress: false });
		let rejectSend: ((error: Error) => void) | undefined;
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
				return {
					async start() {},
					async send() {
						resolveSendStarted?.();
						await new Promise<void>((_resolve, reject) => {
							rejectSend = reject;
						});
					},
					async abort() {
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
		await adapter.receive({ id: "m2", user: { id: "u1", name: "Ronan" }, text: "/status" });
		await adapter.receive({ id: "m3", user: { id: "u2", name: "Other" }, text: "/stop" });
		await adapter.receive({ id: "m4", user: { id: "u1", name: "Ronan" }, text: "/stop" });
		await turn;

		expect(adapter.sent).toEqual([
			{ conversation: "local", thread: undefined, text: "running: local (Ronan)" },
			{ conversation: "local", thread: undefined, text: "You can only control turns you started." },
			{ conversation: "local", thread: undefined, text: "Canceled 1 turn(s)." },
			{ conversation: "local", thread: undefined, text: "Canceled: canceled by chat" },
		]);
		await app.stop();
	});

	it("does not acknowledge or start Pi for denied messages", async () => {
		const cases = [
			{
				name: "passive",
				adapter: local(),
				message: {
					id: "m1",
					user: { id: "u1", name: "Ronan" },
					text: "ambient channel message",
					mentioned: false,
					dm: false,
				},
				acks: 0,
			},
			{
				name: "self",
				adapter: local(),
				message: {
					id: "m1",
					user: { id: "bot", name: "Bot", isBot: true, isSelf: true },
					text: "self reply",
				},
				acks: 0,
			},
			{
				name: "bot",
				adapter: local(),
				message: {
					id: "m1",
					user: { id: "bot-1", name: "Other bot", isBot: true },
					text: "bot request",
				},
				acks: 0,
			},
			{
				name: "allowlist",
				adapter: local({ allow: { users: ["u2"] } }),
				message: {
					id: "m1",
					user: { id: "u1", name: "Ronan" },
					text: "hello",
				},
				acks: 0,
			},
		];

		for (const entry of cases) {
			const root = await makeDir(`app-denied-${entry.name}-agent`);
			const state = await makeDir(`app-denied-${entry.name}-state`);
			let piStarts = 0;

			const app = await createHeypi({
				adapters: [entry.adapter],
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
			await entry.adapter.receive(entry.message);
			await app.stop();

			expect(entry.acks).toBe(0);
			expect(piStarts).toBe(0);
			expect(entry.adapter.sent).toEqual([]);
		}
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

	it("exposes adapter reactions through message events", async () => {
		const root = await makeDir("app-reaction-agent");
		const state = await makeDir("app-reaction-state");
		const adapter = local();
		const reactions: string[] = [];
		adapter.react = async (_message, emoji) => {
			reactions.push(emoji);
		};
		adapter.events = {
			...adapter.events,
			"message.accepted": async (_event, context) => {
				await context.react?.("eyes");
				context.status?.replace("Thinking...");
			},
		};

		const app = await createHeypi({
			adapters: [adapter],
			agent: loadAgent(root, {
				id: "agent",
				state: { dir: state },
			}),
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

		expect(reactions).toEqual(["eyes"]);
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
		expect(adapter.sent).toHaveLength(3);
		expect(adapter.sent).toContainEqual({
			conversation: "local",
			thread: undefined,
			text: "Queued. I’ll start it when the current task finishes.",
		});
		expect(adapter.sent).toContainEqual({ conversation: "local", thread: undefined, text: "Done." });
		expect(adapter.sent).toContainEqual({ conversation: "local", thread: undefined, text: "Done." });
	});

	it("steers the active Pi turn when configured", async () => {
		const root = await makeDir("app-steer-agent");
		const state = await makeDir("app-steer-state");
		const adapter = local({ busy: "steer", progress: false });
		let release: (() => void) | undefined;
		let started: (() => void) | undefined;
		const sending = new Promise<void>((resolve) => {
			started = resolve;
		});
		const steered: string[] = [];
		const app = await createHeypi({
			adapters: [adapter],
			agent: loadAgent(root, { id: "agent", state: { dir: state } }),
			piHost() {
				const listeners: PiListener[] = [];
				return {
					async start() {},
					async send() {
						started?.();
						await new Promise<void>((resolve) => {
							release = resolve;
						});
						emitAssistant(listeners, "Done.");
					},
					async steer(text) {
						steered.push(text);
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
		const first = adapter.receive({ id: "m1", user: { id: "u1" }, text: "first" });
		await sending;
		await adapter.receive({ id: "m2", user: { id: "u1" }, text: "change direction" });
		release?.();
		await first;
		await app.stop();

		expect(steered).toEqual([expect.stringContaining("change direction")]);
		expect(adapter.sent).toContainEqual({
			conversation: "local",
			thread: undefined,
			text: "Updated the active task.",
		});
	});

	it("rejects new turns while busy when configured", async () => {
		const root = await makeDir("app-reject-agent");
		const state = await makeDir("app-reject-state");
		const adapter = local({ busy: "reject", progress: false });
		let release: (() => void) | undefined;
		let started: (() => void) | undefined;
		const sending = new Promise<void>((resolve) => {
			started = resolve;
		});
		const app = await createHeypi({
			adapters: [adapter],
			agent: loadAgent(root, { id: "agent", state: { dir: state } }),
			piHost() {
				return replyHost("Done.", async () => {
					started?.();
					await new Promise<void>((resolve) => {
						release = resolve;
					});
				});
			},
		});

		await app.start();
		const first = adapter.receive({ id: "m1", user: { id: "u1" }, text: "first" });
		await sending;
		await adapter.receive({ id: "m2", user: { id: "u1" }, text: "second" });
		release?.();
		await first;
		await app.stop();

		expect(adapter.sent).toContainEqual({
			conversation: "local",
			thread: undefined,
			text: "I’m already working on another request in this conversation.",
		});
	});
});

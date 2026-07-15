import { constants, createCipheriv, createPublicKey, publicEncrypt, randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
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
			key: createPublicKey({
				key: Buffer.from(request.k, "base64"),
				format: "der",
				type: "spki",
			}),
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
	it("warns when runtime defaults to host execution", async () => {
		const warnings: Array<{ event: string; data?: Record<string, unknown> }> = [];
		const app = await createHeypi({
			adapters: [local("local-dev")],
			agent: loadAgent(await makeDir("app-host-warning-agent"), {
				id: "agent",
				state: { dir: await makeDir("app-host-warning-state") },
			}),
			logger: {
				debug() {},
				info() {},
				warn(event, data) {
					warnings.push({ event, data });
				},
				error() {},
			},
		});

		await app.start();
		await app.stop();

		expect(warnings).toContainEqual({
			event: "security.runtime_default_host",
			data: { reason: "runtime omitted; shell commands execute on the host" },
		});
	});

	it("starts with tool approvals even when adapters do not restrict approvers", async () => {
		const root = await makeDir("app-open-approval-agent");
		const state = await makeDir("app-open-approval-state");
		const app = await createHeypi({
			adapters: [local({ todo: false })],
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

	it("rolls back adapters when startup fails", async () => {
		const root = await makeDir("app-start-rollback-agent");
		const state = await makeDir("app-start-rollback-state");
		const first = local("first");
		const second = local("second");
		const stopped: string[] = [];
		first.stop = async () => {
			stopped.push("first");
		};
		second.stop = async () => {
			stopped.push("second");
		};
		second.start = async () => {
			throw new Error("adapter failed to start");
		};
		const app = await createHeypi({
			adapters: [first, second],
			agent: loadAgent(root, { id: "agent", state: { dir: state } }),
			piHost: () => replyHost(),
		});

		await expect(app.start()).rejects.toThrow("adapter failed to start");
		expect(stopped).toEqual(["second", "first"]);
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
		const adapter = local({ todo: false });
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
						const tool = options.customTools?.find((tool) => tool.name === "chat_request_secret");
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

	it("logs Pi tool activity without emitting progress messages", async () => {
		const root = await makeDir("app-progress-agent");
		const state = await makeDir("app-progress-state");
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
		expect(logs).toContainEqual({
			event: "pi.tool.start",
			data: { adapter: "local", conversation: "local", thread: undefined, tool: "bash" },
		});
		expect(logs).toContainEqual({
			event: "pi.tool.end",
			data: { adapter: "local", conversation: "local", thread: undefined, tool: "bash" },
		});
	});

	it("reports an error when Pi fails", async () => {
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
		const adapter = local({ todo: false });
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

	it("allows human messages by group membership", async () => {
		const root = await makeDir("app-group-allowed-agent");
		const state = await makeDir("app-group-allowed-state");
		const adapter = local({ allow: { groups: ["team-leads"] } });

		const app = await createHeypi({
			adapters: [adapter],
			agent: loadAgent(root, {
				id: "agent",
				state: { dir: state },
			}),
			piHost() {
				return replyHost("Done.");
			},
		});

		await app.start();
		await adapter.receive({
			id: "m1",
			user: { id: "u1", name: "Ronan", groups: ["team-leads"] },
			text: "hello",
		});
		await app.stop();

		expect(adapter.sent).toContainEqual({ conversation: "local", thread: undefined, text: "Done." });
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

	it("emits accepted messages before staging attachments", async () => {
		const root = await makeDir("app-ack-agent");
		const state = await makeDir("app-ack-state");
		const adapter = local({ todo: false });
		const order: string[] = [];
		adapter.events = {
			"message.accepted": async () => {
				order.push("ack");
			},
		};
		adapter.materializeAttachments = async (message) => {
			order.push("stage");
			return message;
		};
		const app = await createHeypi({
			adapters: [adapter],
			agent: loadAgent(root, { id: "agent", state: { dir: state } }),
			piHost: () => replyHost("Done."),
		});

		await app.start();
		await adapter.receive({
			id: "m1",
			user: { id: "u1" },
			text: "Inspect this.",
			attachments: [{ name: "issue.txt", url: "https://example.com/issue.txt" }],
		});
		await app.stop();

		expect(order).toEqual(["ack", "stage"]);
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
		const adapter = local({ busy: "steer", todo: false });
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
		const adapter = local({ busy: "reject", todo: false });
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

	it("can disable DMs explicitly", async () => {
		const adapter = local({ allow: { dms: false }, todo: false });
		let sends = 0;
		const app = await createHeypi({
			adapters: [adapter],
			agent: loadAgent(await makeDir("app-no-dm-agent"), {
				id: "agent",
				state: { dir: await makeDir("app-no-dm-state") },
			}),
			piHost: () =>
				replyHost("Done.", () => {
					sends++;
				}),
		});
		await app.start();

		await adapter.receive({ id: "dm1", user: { id: "u1" }, text: "hello" });
		await app.stop();

		expect(sends).toBe(0);
		expect(adapter.sent).toEqual([]);
	});

	it("uses the parent channel for public access control", async () => {
		const adapter = local({ allow: { channels: ["parent"] }, todo: false });
		const prompts: string[] = [];
		const app = await createHeypi({
			adapters: [adapter],
			agent: loadAgent(await makeDir("app-channel-access-agent"), {
				id: "agent",
				state: { dir: await makeDir("app-channel-access-state") },
			}),
			piHost: () =>
				replyHost("Done.", (prompt) => {
					prompts.push(prompt);
				}),
		});
		await app.start();

		await adapter.receive({
			id: "m1",
			conversation: "native-thread",
			channel: "parent",
			dm: false,
			user: { id: "u1" },
			text: "allowed",
		});
		await adapter.receive({
			id: "m2",
			conversation: "other-thread",
			channel: "other",
			dm: false,
			user: { id: "u1" },
			text: "denied",
		});
		await app.stop();

		expect(prompts).toEqual([expect.stringContaining("allowed")]);
	});

	it("isolates public root mentions into separate Pi sessions", async () => {
		const root = await makeDir("app-public-roots-agent");
		const state = await makeDir("app-public-roots-state");
		const adapter = local({ todo: false });
		const sessions: string[] = [];
		let active = 0;
		let maxActive = 0;
		const app = await createHeypi({
			adapters: [adapter],
			agent: loadAgent(root, { id: "agent", state: { dir: state } }),
			piHost(options) {
				sessions.push(options.sessionDir);
				return replyHost("Done.", async () => {
					active++;
					maxActive = Math.max(maxActive, active);
					await new Promise((resolve) => setTimeout(resolve, 10));
					active--;
				});
			},
		});
		await app.start();

		await Promise.all([
			adapter.receive({ id: "root-1", conversation: "room", dm: false, user: { id: "u1" }, text: "one" }),
			adapter.receive({ id: "root-2", conversation: "room", dm: false, user: { id: "u1" }, text: "two" }),
		]);
		await app.stop();

		expect(sessions).toHaveLength(2);
		expect(new Set(sessions).size).toBe(2);
		expect(maxActive).toBe(1);
		expect(adapter.sent.map((message) => message.replyTo).sort()).toEqual(["root-1", "root-2"]);
	});

	it("continues from every message emitted by a chunked response", async () => {
		const adapter = local({ todo: false });
		const send = adapter.send.bind(adapter);
		let sends = 0;
		adapter.send = async (message) => {
			const sent = await send(message);
			sends++;
			return sends === 1 ? { ...sent, ids: [sent?.id ?? "", "chunk-2"] } : sent;
		};
		const prompts: string[] = [];
		const app = await createHeypi({
			adapters: [adapter],
			agent: loadAgent(await makeDir("app-chunk-reply-agent"), {
				id: "agent",
				state: { dir: await makeDir("app-chunk-reply-state") },
			}),
			piHost: () =>
				replyHost("Done.", (prompt) => {
					prompts.push(prompt);
				}),
		});
		await app.start();

		await adapter.receive({ id: "root", conversation: "room", dm: false, user: { id: "u1" }, text: "start" });
		await adapter.receive({
			id: "follow-up",
			conversation: "room",
			dm: false,
			mentioned: false,
			replyTo: "chunk-2",
			user: { id: "u1" },
			text: "continue",
		});
		await app.stop();

		expect(prompts).toHaveLength(2);
		expect(prompts[1]).toContain("continue");
	});

	it("continues from direct control responses", async () => {
		const adapter = local({ admins: { users: ["u1"] }, todo: false });
		const prompts: string[] = [];
		const app = await createHeypi({
			adapters: [adapter],
			agent: loadAgent(await makeDir("app-control-reply-agent"), {
				id: "agent",
				state: { dir: await makeDir("app-control-reply-state") },
			}),
			piHost: () =>
				replyHost("Done.", (prompt) => {
					prompts.push(prompt);
				}),
		});
		await app.start();

		await adapter.receive({ id: "status", conversation: "room", dm: false, user: { id: "u1" }, text: "/status" });
		await adapter.receive({
			id: "follow-up",
			conversation: "room",
			dm: false,
			mentioned: false,
			replyTo: "local-1",
			user: { id: "u1" },
			text: "start actual work",
		});
		await app.stop();

		expect(prompts).toEqual([expect.stringContaining("start actual work")]);
	});

	it("restores public reply-chain sessions after restart and across users", async () => {
		const root = await makeDir("app-reply-restart-agent");
		const state = await makeDir("app-reply-restart-state");
		const first = local({ todo: false });
		const firstApp = await createHeypi({
			adapters: [first],
			agent: loadAgent(root, { id: "agent", state: { dir: state } }),
			piHost: () => replyHost("First reply."),
		});
		await firstApp.start();
		await first.receive({
			id: "root",
			conversation: "room",
			dm: false,
			user: { id: "u1" },
			text: "start",
		});
		await firstApp.stop();

		const prompts: string[] = [];
		const second = local({ todo: false });
		const secondApp = await createHeypi({
			adapters: [second],
			agent: loadAgent(root, { id: "agent", state: { dir: state } }),
			piHost: () =>
				replyHost("Second reply.", (prompt) => {
					prompts.push(prompt);
				}),
		});
		await secondApp.start();
		await second.receive({
			id: "follow-up",
			conversation: "room",
			dm: false,
			mentioned: false,
			replyTo: "local-1",
			user: { id: "u2" },
			text: "continue",
		});
		await secondApp.stop();

		expect(prompts).toEqual([expect.stringContaining("continue")]);
		expect(second.sent).toContainEqual({
			conversation: "room",
			thread: undefined,
			replyTo: "follow-up",
			text: "Second reply.",
		});
	});

	it("dispatches authored schedules through the conversation queue", async () => {
		const root = await makeDir("app-schedule-agent");
		const state = await makeDir("app-schedule-state");
		await mkdir(join(root, "schedules"), { recursive: true });
		await writeFile(
			join(root, "schedules", "report.js"),
			`export default {
				cron: "0 0 1 1 *",
				timezone: "UTC",
				async run({ dispatch }) {
					await dispatch({ prompt: "Prepare report.", target: { adapterId: "local", conversation: "reports" } });
				}
			};`,
		);
		const adapter = local({ todo: false });
		const prompts: string[] = [];
		const app = await createHeypi({
			adapters: [adapter],
			agent: loadAgent(root, { id: "agent", state: { dir: state } }),
			piHost() {
				return replyHost("Scheduled reply.", (prompt) => {
					prompts.push(prompt);
				});
			},
		});
		await app.start();

		const run = await app.schedules.run("report");
		for (let attempt = 0; attempt < 20 && app.schedules.runs("report").at(-1)?.status !== "completed"; attempt++) {
			await new Promise((resolve) => setTimeout(resolve, 5));
		}
		await app.stop();

		expect(run).toMatchObject({ status: "claimed" });
		expect(app.schedules.runs("report").at(-1)).toMatchObject({
			status: "completed",
			output: "Scheduled reply.",
		});
		expect(prompts).toEqual(["Prepare report."]);
		expect(adapter.sent).toContainEqual({ conversation: "reports", thread: undefined, text: "Scheduled reply." });
	});

	it("runs prompt schedules in fresh background Pi sessions", async () => {
		const root = await makeDir("app-background-schedule-agent");
		const state = await makeDir("app-background-schedule-state");
		await mkdir(join(root, "schedules"), { recursive: true });
		await writeFile(
			join(root, "schedules", "cleanup.js"),
			`export default { cron: "0 0 1 1 *", timezone: "UTC", prompt: "Clean up." };`,
		);
		const options: PiHostOptions[] = [];
		const app = await createHeypi({
			adapters: [local({ todo: false })],
			agent: loadAgent(root, { id: "agent", state: { dir: state } }),
			piHost(input) {
				options.push(input);
				return replyHost("Cleanup complete.");
			},
		});
		await app.start();

		const run = await app.schedules.run("cleanup");
		for (let attempt = 0; attempt < 20 && app.schedules.runs("cleanup").at(-1)?.status !== "completed"; attempt++) {
			await new Promise((resolve) => setTimeout(resolve, 5));
		}
		await app.stop();

		expect(run).toMatchObject({ status: "claimed" });
		expect(app.schedules.runs("cleanup").at(-1)).toMatchObject({
			status: "completed",
			output: "Cleanup complete.",
		});
		expect(options).toHaveLength(1);
		expect(options[0]).toMatchObject({ mode: "background", customTools: [] });
	});
});

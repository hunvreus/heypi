import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { consoleLogger } from "../src/core/log.js";
import type { AttachmentStore } from "../src/io/attachments.js";
import { DeliveryQueue } from "../src/io/delivery.js";
import type { HttpRoute } from "../src/io/handler.js";
import { DraftReplyStream } from "../src/io/reply-stream.js";
import {
	parseTelegramCallback,
	startProgress,
	telegram,
	telegramApprovalText,
	telegramChunks,
} from "../src/io/telegram.js";

test("telegram webhook mode registers one HTTP route and bot commands", async () => {
	const calls: string[] = [];
	const restore = mockTelegramFetch(calls);
	try {
		const routes: HttpRoute[] = [];
		const adapter = telegram({ token: "token", mode: "webhook", webhook: { secretToken: "secret" } });
		await adapter.start({
			handler: async () => undefined,
			logger: consoleLogger({ level: "error", format: "pretty" }),
			http: { register: (route) => routes.push(route) },
		});

		assert.deepEqual(
			routes.map((route) => [route.method, route.path, route.port]),
			[["POST", "/telegram/telegram/webhook", undefined]],
		);
		assert.deepEqual(calls, ["getMe", "setMyCommands"]);
	} finally {
		restore();
	}
});

test("telegram webhook acknowledges before processing the update", async () => {
	const restore = mockTelegramFetch([]);
	let release!: () => void;
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	let handled = false;
	try {
		const routes: HttpRoute[] = [];
		const adapter = telegram({ token: "token", mode: "webhook", webhook: { secretToken: "secret" } });
		await adapter.start({
			handler: async () => {
				handled = true;
				await gate;
				return undefined;
			},
			logger: consoleLogger({ level: "error", format: "pretty" }),
			http: { register: (route) => routes.push(route) },
		});
		const server = await routeServer(routes[0]);
		try {
			const response = await fetch(server.url, {
				method: "POST",
				headers: {
					"content-type": "application/json",
					"x-telegram-bot-api-secret-token": "secret",
				},
				body: JSON.stringify(telegramUpdate("hello")),
			});

			assert.equal(response.status, 200);
			assert.deepEqual(await response.json(), { ok: true });
			await eventually(() => handled);
		} finally {
			release();
			await server.close();
		}
	} finally {
		restore();
	}
});

test("telegram webhook forwards message_id separately from update_id", async () => {
	const restore = mockTelegramFetch([]);
	let inbound:
		| {
				eventId?: string;
				providerMessageId?: string;
				thread: string;
		  }
		| undefined;
	try {
		const routes: HttpRoute[] = [];
		const adapter = telegram({ token: "token", mode: "webhook", webhook: { secretToken: "secret" } });
		await adapter.start({
			handler: async (msg) => {
				inbound = { eventId: msg.eventId, providerMessageId: msg.providerMessageId, thread: msg.thread };
				return undefined;
			},
			logger: consoleLogger({ level: "error", format: "pretty" }),
			http: { register: (route) => routes.push(route) },
		});
		const server = await routeServer(routes[0]);
		try {
			const update = { update_id: 99, message: telegramMessage("hello", 10) };
			const response = await fetch(server.url, {
				method: "POST",
				headers: {
					"content-type": "application/json",
					"x-telegram-bot-api-secret-token": "secret",
				},
				body: JSON.stringify(update),
			});

			assert.equal(response.status, 200);
			await eventually(() => inbound !== undefined);
			assert.deepEqual(inbound, {
				eventId: "99",
				providerMessageId: "10",
				thread: "42:42",
			});
		} finally {
			await server.close();
		}
	} finally {
		restore();
	}
});

test("telegram webhook rejects bad secret token", async () => {
	const restore = mockTelegramFetch([]);
	try {
		const routes: HttpRoute[] = [];
		const adapter = telegram({ token: "token", mode: "webhook", webhook: { secretToken: "secret" } });
		await adapter.start({
			handler: async () => {
				throw new Error("handler should not run");
			},
			logger: consoleLogger({ level: "error", format: "pretty" }),
			http: { register: (route) => routes.push(route) },
		});
		const server = await routeServer(routes[0]);
		try {
			const response = await fetch(server.url, {
				method: "POST",
				headers: {
					"content-type": "application/json",
					"x-telegram-bot-api-secret-token": "wrong",
				},
				body: JSON.stringify(telegramUpdate("hello")),
			});

			assert.equal(response.status, 401);
		} finally {
			await server.close();
		}
	} finally {
		restore();
	}
});

test("telegram webhook mode requires a secret token", () => {
	assert.throws(() => telegram({ token: "token", mode: "webhook" }), /webhook.secretToken/);
});

test("telegram mode must be valid", () => {
	assert.throws(
		() => telegram({ token: "token", mode: "invalid" as "polling" }),
		/Telegram mode must be "polling" or "webhook"/,
	);
});

test("telegram webhook path overrides must be explicit", () => {
	assert.throws(
		() => telegram({ token: "token", mode: "webhook", webhook: { path: "/hook", secretToken: "secret" } }),
		/unsafePathOverride: true/,
	);
});

test("parseTelegramCallback parses control actions", () => {
	assert.deepEqual(parseTelegramCallback("approve:abc"), { kind: "approve", id: "abc" });
	assert.deepEqual(parseTelegramCallback("deny:def"), { kind: "deny", id: "def" });
	assert.deepEqual(parseTelegramCallback("cancel:trace-1"), { kind: "cancel", id: "trace-1" });
	assert.deepEqual(parseTelegramCallback("status"), { kind: "status" });
	assert.equal(parseTelegramCallback("unknown:abc"), undefined);
	assert.equal(parseTelegramCallback("approve:"), undefined);
});

test("telegramChunks keeps markup chunks under Telegram edit limits", () => {
	const text = "a".repeat(3900);
	const chunks = telegramChunks(text, true);

	assert.equal(chunks.length, 2);
	assert.equal(
		chunks.every((chunk) => chunk.length <= 3800),
		true,
	);
});

test("Telegram approval resolution preserves approval text and appends status", () => {
	const approval = {
		id: "approval-1",
		callId: "call-1",
		command: "curl --version",
		runtime: "just-bash",
		reason: "Run bash command.",
		allowed: [],
		requestedBy: "42",
		details: [{ label: "Command", value: "curl --version", format: "code" as const }],
	};
	const pending = telegramApprovalText("ignored", approval);
	const approved = telegramApprovalText("ignored", approval, "approved", "user 42");

	assert.match(pending, /^\*Approval required\*/);
	assert.match(pending, /Approval ID: approval-1/);
	assert.match(approved, /^\*Approved\*/);
	assert.match(approved, /Reason:\nRun bash command/);
	assert.match(approved, /Approved by user 42/);
});

test("Telegram streaming adopts the progress message instead of deleting it", async () => {
	const calls: unknown[] = [];
	const client = {
		sendMessage: async (message: unknown) => {
			calls.push({ method: "sendMessage", message });
			return { message_id: 10 };
		},
		editMessageText: async (message: unknown) => {
			calls.push({ method: "editMessageText", message });
			return { ok: true };
		},
		deleteMessage: async (message: unknown) => {
			calls.push({ method: "deleteMessage", message });
			return { ok: true };
		},
	};
	const progress = startProgress({
		client: client as unknown as Parameters<typeof startProgress>[0]["client"],
		chatId: 42,
		replyTo: 1,
		cancelId: "trace-1",
		progress: { delayMs: 0 },
		logger: consoleLogger({ level: "error", format: "pretty" }),
		context: {},
		delivery: new DeliveryQueue(false),
	});
	await eventually(() => calls.some((call) => methodOf(call) === "sendMessage"));
	const stream = new DraftReplyStream(
		{
			limit: 100,
			create: async (text) => {
				const adopted = await progress.takeover();
				if (!adopted) throw new Error("expected progress message takeover");
				await client.editMessageText({
					chat_id: 42,
					message_id: Number(adopted),
					text,
					reply_markup: { inline_keyboard: [] },
				});
				return adopted;
			},
			edit: async (id, text) => {
				await client.editMessageText({
					chat_id: 42,
					message_id: Number(id),
					text,
					reply_markup: { inline_keyboard: [] },
				});
			},
			delete: async (id) => {
				await client.deleteMessage({ chat_id: 42, message_id: Number(id) });
			},
		},
		{ intervalMs: 1, minChars: 1 },
	);

	await stream.update("streaming");
	await stream.finalize("streaming done");

	assert.deepEqual(
		calls.map((call) => methodOf(call)),
		["sendMessage", "editMessageText", "editMessageText"],
	);
	assert.deepEqual(calls.at(1), {
		method: "editMessageText",
		message: { chat_id: 42, message_id: 10, text: "streaming", reply_markup: { inline_keyboard: [] } },
	});
	assert.deepEqual(calls.at(2), {
		method: "editMessageText",
		message: { chat_id: 42, message_id: 10, text: "streaming done", reply_markup: { inline_keyboard: [] } },
	});
});

test("Telegram scheduled target uploads attachments", async () => {
	const events: TelegramFetchEvent[] = [];
	const restore = mockTelegramFetchDetailed(events);
	const root = await mkdtemp(join(tmpdir(), "heypi-telegram-attachment-"));
	try {
		const file = join(root, "report.html");
		await writeFile(file, "<html></html>");
		const store = attachmentStore(file);
		const adapter = telegram({ token: "token" });
		assert.ok(adapter.send);

		await adapter.send(
			{ channel: "42", thread: "7" },
			{
				text: "Attached: report.html",
				attachments: [{ path: "report.html", name: "report.html", mimeType: "text/html" }],
			},
			{
				handler: async () => undefined,
				logger: consoleLogger({ level: "error", format: "pretty" }),
				attachments: store,
			},
		);

		assert.deepEqual(deliveryMethods(events), ["sendMessage", "sendDocument"]);
	} finally {
		restore();
		await rm(root, { recursive: true, force: true });
	}
});

test("Telegram scheduled attachment upload failure is visible in the chat", async () => {
	const events: TelegramFetchEvent[] = [];
	const restore = mockTelegramFetchDetailed(events, { failDocument: true });
	const root = await mkdtemp(join(tmpdir(), "heypi-telegram-attachment-fail-"));
	try {
		const file = join(root, "report.html");
		await writeFile(file, "<html></html>");
		const store = attachmentStore(file);
		const adapter = telegram({ token: "token" });
		assert.ok(adapter.send);

		await adapter.send(
			{ channel: "42", thread: "7" },
			{
				text: "Attached: report.html",
				attachments: [{ path: "report.html", name: "report.html", mimeType: "text/html" }],
			},
			{
				handler: async () => undefined,
				logger: consoleLogger({ level: "error", format: "pretty" }),
				attachments: store,
			},
		);

		assert.deepEqual(deliveryMethods(events), ["sendMessage", "sendDocument", "sendMessage"]);
		const notice = events.filter((event) => event.method === "sendMessage").at(-1);
		assert.match(String(notice?.body?.text), /Telegram did not accept the upload/);
	} finally {
		restore();
		await rm(root, { recursive: true, force: true });
	}
});

function mockTelegramFetch(calls: string[]): () => void {
	const original = globalThis.fetch;
	globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
		const value = String(url);
		if (value.startsWith("http://127.0.0.1:")) return original(url, init);
		const method = value.slice(value.lastIndexOf("/") + 1);
		calls.push(method);
		if (method === "getMe") {
			return jsonResponse({ ok: true, result: { id: 123, is_bot: true, username: "heypi_bot" } });
		}
		if (method === "setMyCommands") return jsonResponse({ ok: true, result: true });
		if (method === "sendMessage") return jsonResponse({ ok: true, result: telegramMessage("ok", 2) });
		return jsonResponse({ ok: true, result: true });
	}) as typeof fetch;
	return () => {
		globalThis.fetch = original;
	};
}

type TelegramFetchEvent = {
	method: string;
	body?: Record<string, unknown>;
};

function mockTelegramFetchDetailed(events: TelegramFetchEvent[], options: { failDocument?: boolean } = {}): () => void {
	const original = globalThis.fetch;
	globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
		const value = String(url);
		if (value.startsWith("http://127.0.0.1:")) return original(url, init);
		const method = value.slice(value.lastIndexOf("/") + 1);
		const body = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : undefined;
		events.push({ method, body });
		if (method === "sendDocument" && options.failDocument) {
			return jsonResponse({ ok: false, description: "forbidden" }, 403);
		}
		if (method === "sendMessage") return jsonResponse({ ok: true, result: telegramMessage("ok", events.length) });
		return jsonResponse({ ok: true, result: true });
	}) as typeof fetch;
	return () => {
		globalThis.fetch = original;
	};
}

function attachmentStore(file: string): AttachmentStore {
	return {
		async save() {
			throw new Error("unused");
		},
		async resolve() {
			return { path: file, name: "report.html", mimeType: "text/html", size: 13 };
		},
	};
}

function deliveryMethods(events: TelegramFetchEvent[]): string[] {
	return events.map((event) => event.method).filter((method) => method !== "deleteMessage");
}

function methodOf(input: unknown): string | undefined {
	return typeof input === "object" && input !== null && "method" in input ? String(input.method) : undefined;
}

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function telegramUpdate(text: string) {
	return { update_id: 1, message: telegramMessage(text, 1) };
}

function telegramMessage(text: string, messageId: number) {
	return {
		message_id: messageId,
		from: { id: 42, first_name: "Alice" },
		chat: { id: 42, type: "private", first_name: "Alice" },
		text,
	};
}

async function routeServer(route: HttpRoute): Promise<{ url: string; close: () => Promise<void> }> {
	const server = createServer((req, res) => void route.handler(req, res));
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			server.off("error", reject);
			resolve();
		});
	});
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("server did not bind");
	return {
		url: `http://127.0.0.1:${address.port}${route.path}`,
		close: () => closeServer(server),
	};
}

function closeServer(server: Server): Promise<void> {
	return new Promise((resolve, reject) => {
		server.close((error) => (error ? reject(error) : resolve()));
	});
}

async function eventually(check: () => boolean): Promise<void> {
	for (let index = 0; index < 50; index++) {
		if (check()) return;
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
	assert.equal(check(), true);
}

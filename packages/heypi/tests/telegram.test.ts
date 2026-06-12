import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { test } from "node:test";
import { consoleLogger } from "../src/core/log.js";
import type { HttpRoute } from "../src/io/handler.js";
import { parseTelegramCallback, telegram, telegramApprovalText, telegramChunks } from "../src/io/telegram.js";

test("telegram webhook mode registers one HTTP route and bot commands", async () => {
	const calls: string[] = [];
	const restore = mockTelegramFetch(calls);
	try {
		const routes: HttpRoute[] = [];
		const adapter = telegram({ token: "token", mode: "webhook" });
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

test("telegram webhook path overrides must be explicit", () => {
	assert.throws(
		() => telegram({ token: "token", mode: "webhook", webhook: { path: "/hook" } }),
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

function jsonResponse(body: unknown): Response {
	return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
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

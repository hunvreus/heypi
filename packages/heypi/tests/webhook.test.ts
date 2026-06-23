import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import { consoleLogger, webhook } from "@hunvreus/heypi";
import type { Handler, HttpRoute } from "@hunvreus/heypi/adapter";

test("webhook uses the adapter name in the default route prefix", async () => {
	const port = await freePort();
	const secret = "test-secret";
	const adapter = webhook({ name: "github", secret, port });
	await adapter.start({
		handler: async () => ({ text: "ok" }),
		logger: consoleLogger({ level: "error", format: "pretty" }),
	});
	try {
		const response = await post(port, "/webhook/github/messages", secret, { text: "hello" });
		assert.equal(response.status, 202);
	} finally {
		await adapter.stop?.();
	}
});

test("webhook can use the shared app HTTP listener defaults", async () => {
	const routes: HttpRoute[] = [];
	const adapter = webhook({ name: "notes", secret: "test-secret" });
	await adapter.start({
		handler: async () => ({ text: "ok" }),
		logger: consoleLogger({ level: "error", format: "pretty" }),
		http: {
			register: (route) => routes.push(route),
		},
	});
	assert.deepEqual(
		routes.map((route) => [route.method, route.path, route.host, route.port]),
		[
			["POST", "/webhook/notes", undefined, undefined],
			["POST", "/webhook/notes/messages", undefined, undefined],
			["POST", "/webhook/notes/threads/:threadId/messages", undefined, undefined],
			["GET", "/webhook/notes/threads/:threadId/runs/:runId", undefined, undefined],
		],
	);
});

test("webhook path overrides must be explicit", async () => {
	const port = await freePort();
	assert.throws(() => webhook({ secret: "test-secret", port, path: "/hook" }), /unsafePathOverride: true/);
});

test("webhook creates server-side threads and exposes async run status", async () => {
	const port = await freePort();
	const secret = "test-secret";
	const seen: Array<{ channel: string; thread: string; text: string; actor: string }> = [];
	const statuses = new Map<string, { ok: boolean; threadId: string; runId: string; status: string; text: string }>();
	const adapter = webhook({ secret, port, path: "/hook", unsafePathOverride: true });
	const handler: Handler = async (input) => {
		seen.push({ channel: input.channel, thread: input.thread, text: input.text, actor: input.actor });
		statuses.set(input.trace ?? "", {
			ok: true,
			threadId: input.thread,
			runId: input.trace ?? "",
			status: "done",
			text: `ok ${input.text}`,
		});
		return { text: `ok ${input.text}` };
	};
	await adapter.start({
		handler,
		status: async ({ runId }) => statuses.get(runId),
		logger: consoleLogger({ level: "error", format: "pretty" }),
	});
	try {
		const first = await post(port, "/hook/messages", secret, { user: "alice", text: "hello" });
		assert.equal(first.status, 202);
		assert.match(String(first.body.threadId), /^whth_/);
		assert.equal(first.body.status, "running");

		const done = await poll(port, `/hook/threads/${first.body.threadId}/runs/${first.body.runId}`, secret);
		assert.equal(done.status, "done");
		assert.equal(done.text, "ok hello");
		assert.equal(seen[0].channel, first.body.threadId);
		assert.equal(seen[0].thread, first.body.threadId);

		const second = await post(port, `/hook/threads/${first.body.threadId}/messages`, secret, {
			user: "alice",
			text: "/status",
			sync: true,
		});
		assert.equal(second.status, 200);
		assert.equal(second.body.threadId, first.body.threadId);
		assert.equal(seen[1].text, "/status");
	} finally {
		await adapter.stop?.();
	}
});

test("webhook rejects requests without the configured secret", async () => {
	const port = await freePort();
	const adapter = webhook({ secret: "test-secret", port });
	await adapter.start({
		handler: async () => ({ text: "no" }),
		logger: consoleLogger({ level: "error", format: "pretty" }),
	});
	try {
		const response = await fetch(`http://127.0.0.1:${port}/webhook/webhook/messages`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ text: "hello" }),
		});
		assert.equal(response.status, 401);
	} finally {
		await adapter.stop?.();
	}
});

test("webhook run status reads from adapter status lookup", async () => {
	const port = await freePort();
	const secret = "test-secret";
	const adapter = webhook({ secret, port });
	await adapter.start({
		handler: async () => ({ text: "ok" }),
		status: async ({ threadId, runId }) => ({ ok: true, threadId, runId, status: "done", text: "from store" }),
		logger: consoleLogger({ level: "error", format: "pretty" }),
	});
	try {
		const response = await fetch(`http://127.0.0.1:${port}/webhook/webhook/threads/t1/runs/r1`, {
			headers: { authorization: `Bearer ${secret}` },
		});
		assert.equal(response.status, 200);
		assert.deepEqual(await response.json(), {
			ok: true,
			threadId: "t1",
			runId: "r1",
			status: "done",
			text: "from store",
		});
	} finally {
		await adapter.stop?.();
	}
});

test("webhook returns structured approval details", async () => {
	const port = await freePort();
	const secret = "test-secret";
	const approval = {
		id: "approval-1",
		callId: "call-1",
		command: "set_project_status",
		runtime: "tool",
		reason: "Update project status.",
		allowed: ["alice"],
		requestedBy: "alice",
		details: [
			{ label: "Project", value: "mobile-beta", format: "text" as const },
			{ label: "Command", value: "deploy --check", format: "code" as const },
		],
	};
	const adapter = webhook({ secret, port });
	await adapter.start({
		handler: async () => ({
			text: "approval required",
			approval,
		}),
		logger: consoleLogger({ level: "error", format: "pretty" }),
	});
	try {
		const response = await post(port, "/webhook/webhook/messages", secret, {
			user: "alice",
			text: "set status",
			sync: true,
		});
		assert.equal(response.status, 200);
		assert.deepEqual(response.body.approval, approval);
		assert.equal(response.body.status, "pending_approval");
	} finally {
		await adapter.stop?.();
	}
});

test("webhook rejects oversized bodies", async () => {
	const port = await freePort();
	const secret = "test-secret";
	const adapter = webhook({ secret, port, maxBodyBytes: 10 });
	await adapter.start({
		handler: async () => ({ text: "ok" }),
		logger: consoleLogger({ level: "error", format: "pretty" }),
	});
	try {
		const response = await fetch(`http://127.0.0.1:${port}/webhook/webhook/messages`, {
			method: "POST",
			headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" },
			body: JSON.stringify({ text: "this is too large" }),
		});
		assert.equal(response.status, 413);
		assert.deepEqual(await response.json(), { ok: false, error: "body too large" });
	} finally {
		await adapter.stop?.();
	}
});

test("webhook rejects replyUrl hosts outside the allowlist", async () => {
	const port = await freePort();
	const secret = "test-secret";
	const adapter = webhook({ secret, port, replyHosts: ["allowed.example.com"] });
	await adapter.start({
		handler: async () => ({ text: "ok" }),
		logger: consoleLogger({ level: "error", format: "pretty" }),
	});
	try {
		const response = await post(port, "/webhook/webhook/messages", secret, {
			text: "hello",
			replyUrl: "https://blocked.example.com/callback",
		});
		assert.equal(response.status, 400);
		assert.equal(response.body.error, "replyUrl host is not allowed");
	} finally {
		await adapter.stop?.();
	}
});

test("webhook replyHosts matching is case-insensitive", async () => {
	const port = await freePort();
	const secret = "test-secret";
	const adapter = webhook({ secret, port, replyHosts: ["ALLOWED.example.com"] });
	await adapter.start({
		handler: async () => ({ text: "ok" }),
		logger: consoleLogger({ level: "error", format: "pretty" }),
	});
	try {
		const response = await post(port, "/webhook/webhook/messages", secret, {
			text: "hello",
			sync: true,
			replyUrl: "https://allowed.example.com/callback",
		});
		assert.equal(response.status, 200);
	} finally {
		await adapter.stop?.();
	}
});

test("webhook allows exact replyUrl callbacks", async () => {
	const port = await freePort();
	const callbackPort = await freePort();
	const secret = "test-secret";
	let callbacks = 0;
	const callback = createServer((_req, res) => {
		callbacks++;
		res.writeHead(204);
		res.end();
	});
	await new Promise<void>((resolve) => callback.listen(callbackPort, "127.0.0.1", resolve));
	const replyUrl = `http://127.0.0.1:${callbackPort}/callback?token=one`;
	const adapter = webhook({ secret, port, replyUrls: [replyUrl], unsafeReplyHttp: true });
	await adapter.start({
		handler: async () => ({ text: "ok" }),
		logger: consoleLogger({ level: "error", format: "pretty" }),
	});
	try {
		const response = await post(port, "/webhook/webhook/messages", secret, {
			text: "hello",
			sync: true,
			replyUrl,
		});
		assert.equal(response.status, 200);
		assert.equal(callbacks, 1);
		const blocked = await post(port, "/webhook/webhook/messages", secret, {
			text: "hello",
			replyUrl: `http://127.0.0.1:${callbackPort}/callback?token=two`,
		});
		assert.equal(blocked.status, 400);
		assert.equal(blocked.body.error, "replyUrl is not allowed");
	} finally {
		await adapter.stop?.();
		callback.closeAllConnections();
		await new Promise<void>((resolve, reject) => callback.close((error) => (error ? reject(error) : resolve())));
	}
});

test("webhook exact replyUrl matching ignores fragments", async () => {
	const port = await freePort();
	const callbackPort = await freePort();
	const secret = "test-secret";
	let callbacks = 0;
	const callback = createServer((_req, res) => {
		callbacks++;
		res.writeHead(204);
		res.end();
	});
	await new Promise<void>((resolve) => callback.listen(callbackPort, "127.0.0.1", resolve));
	const replyUrl = `http://127.0.0.1:${callbackPort}/callback?token=one`;
	const adapter = webhook({ secret, port, replyUrls: [`${replyUrl}#configured`], unsafeReplyHttp: true });
	await adapter.start({
		handler: async () => ({ text: "ok" }),
		logger: consoleLogger({ level: "error", format: "pretty" }),
	});
	try {
		const response = await post(port, "/webhook/webhook/messages", secret, {
			text: "hello",
			sync: true,
			replyUrl: `${replyUrl}#request`,
		});
		assert.equal(response.status, 200);
		assert.equal(callbacks, 1);
	} finally {
		await adapter.stop?.();
		callback.closeAllConnections();
		await new Promise<void>((resolve, reject) => callback.close((error) => (error ? reject(error) : resolve())));
	}
});

test("webhook allows replyUrl callbacks by origin", async () => {
	const port = await freePort();
	const callbackPort = await freePort();
	const secret = "test-secret";
	let callbacks = 0;
	const callback = createServer((_req, res) => {
		callbacks++;
		res.writeHead(204);
		res.end();
	});
	await new Promise<void>((resolve) => callback.listen(callbackPort, "127.0.0.1", resolve));
	const adapter = webhook({
		secret,
		port,
		replyOrigins: [`http://127.0.0.1:${callbackPort}`],
		unsafeReplyHttp: true,
	});
	await adapter.start({
		handler: async () => ({ text: "ok" }),
		logger: consoleLogger({ level: "error", format: "pretty" }),
	});
	try {
		const response = await post(port, "/webhook/webhook/messages", secret, {
			text: "hello",
			sync: true,
			replyUrl: `http://127.0.0.1:${callbackPort}/callback/path`,
		});
		assert.equal(response.status, 200);
		assert.equal(callbacks, 1);
		const blocked = await post(port, "/webhook/webhook/messages", secret, {
			text: "hello",
			replyUrl: "http://127.0.0.1:1/callback",
		});
		assert.equal(blocked.status, 400);
		assert.equal(blocked.body.error, "replyUrl origin is not allowed");
	} finally {
		await adapter.stop?.();
		callback.closeAllConnections();
		await new Promise<void>((resolve, reject) => callback.close((error) => (error ? reject(error) : resolve())));
	}
});

test("webhook rejects replyUrl credentials", async () => {
	const port = await freePort();
	const secret = "test-secret";
	const adapter = webhook({ secret, port, replyOrigins: ["https://allowed.example.com"] });
	await adapter.start({
		handler: async () => ({ text: "ok" }),
		logger: consoleLogger({ level: "error", format: "pretty" }),
	});
	try {
		const response = await post(port, "/webhook/webhook/messages", secret, {
			text: "hello",
			replyUrl: "https://user:pass@allowed.example.com/callback",
		});
		assert.equal(response.status, 400);
		assert.equal(response.body.error, "replyUrl must not include credentials");
	} finally {
		await adapter.stop?.();
	}
});

test("webhook validates replyUrl allowlist config", () => {
	assert.throws(() => webhook({ secret: "test-secret", replyUrls: ["not a url"] }), /invalid webhook replyUrls/);
	assert.throws(
		() => webhook({ secret: "test-secret", replyUrls: ["http://example.com/callback"] }),
		/replyUrls must use https/,
	);
	assert.throws(
		() => webhook({ secret: "test-secret", replyUrls: ["https://user:pass@example.com/callback"] }),
		/replyUrls entries must not include credentials/,
	);
	assert.throws(
		() => webhook({ secret: "test-secret", replyOrigins: ["https://example.com/callback"] }),
		/replyOrigins entries must be origins/,
	);
	assert.doesNotThrow(() =>
		webhook({ secret: "test-secret", replyOrigins: ["http://example.com"], unsafeReplyHttp: true }),
	);
});

test("webhook replyUrl requires https unless explicitly allowed", async () => {
	const port = await freePort();
	const secret = "test-secret";
	const adapter = webhook({ secret, port, replyHosts: ["127.0.0.1"] });
	await adapter.start({
		handler: async () => ({ text: "ok" }),
		logger: consoleLogger({ level: "error", format: "pretty" }),
	});
	try {
		const response = await post(port, "/webhook/webhook/messages", secret, {
			text: "hello",
			replyUrl: "http://127.0.0.1/callback",
		});
		assert.equal(response.status, 400);
		assert.equal(response.body.error, "replyUrl must use https");
	} finally {
		await adapter.stop?.();
	}
});

test("webhook times out slow replyUrl callbacks", async () => {
	const port = await freePort();
	const callbackPort = await freePort();
	const secret = "test-secret";
	const callback = createServer((_req, res) => {
		setTimeout(() => {
			res.writeHead(204);
			res.end();
		}, 300);
	});
	await new Promise<void>((resolve) => callback.listen(callbackPort, "127.0.0.1", resolve));
	const adapter = webhook({ secret, port, replyHosts: ["127.0.0.1"], replyTimeoutMs: 20, unsafeReplyHttp: true });
	await adapter.start({
		handler: async () => ({ text: "ok" }),
		logger: consoleLogger({ level: "error", format: "pretty" }),
	});
	try {
		const started = Date.now();
		const response = await post(port, "/webhook/webhook/messages", secret, {
			text: "hello",
			sync: true,
			replyUrl: `http://127.0.0.1:${callbackPort}/callback`,
		});
		assert.equal(response.status, 200);
		assert.equal(response.body.status, "done");
		assert.ok(Date.now() - started < 250);
	} finally {
		await adapter.stop?.();
		callback.closeAllConnections();
		await new Promise<void>((resolve, reject) => callback.close((error) => (error ? reject(error) : resolve())));
	}
});

test("webhook rejects user-supplied generated thread id prefixes", async () => {
	const port = await freePort();
	const secret = "test-secret";
	const adapter = webhook({ secret, port });
	await adapter.start({
		handler: async () => ({ text: "ok" }),
		logger: consoleLogger({ level: "error", format: "pretty" }),
	});
	try {
		const response = await post(port, "/webhook/webhook/messages", secret, {
			threadId: "whth_user_supplied",
			text: "hello",
		});
		assert.equal(response.status, 400);
		assert.equal(response.body.error, "threadId uses a reserved prefix");
	} finally {
		await adapter.stop?.();
	}
});

test("webhook caps in-flight async runs", async () => {
	const port = await freePort();
	const secret = "test-secret";
	let release!: () => void;
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	const adapter = webhook({ secret, port, maxInFlight: 1 });
	await adapter.start({
		handler: async () => {
			await gate;
			return { text: "ok" };
		},
		logger: consoleLogger({ level: "error", format: "pretty" }),
	});
	try {
		const first = await post(port, "/webhook/webhook/messages", secret, { text: "first" });
		assert.equal(first.status, 202);
		const second = await post(port, "/webhook/webhook/messages", secret, { text: "second" });
		assert.equal(second.status, 429);
		assert.equal(second.body.error, "too many in-flight webhook runs");
		release();
	} finally {
		await adapter.stop?.();
	}
});

async function post(
	port: number,
	path: string,
	secret: string,
	body: Record<string, unknown>,
): Promise<{ status: number; body: Record<string, unknown> }> {
	const response = await fetch(`http://127.0.0.1:${port}${path}`, {
		method: "POST",
		headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" },
		body: JSON.stringify(body),
	});
	return { status: response.status, body: (await response.json()) as Record<string, string> };
}

async function poll(port: number, path: string, secret: string): Promise<Record<string, string>> {
	for (let i = 0; i < 20; i++) {
		const response = await fetch(`http://127.0.0.1:${port}${path}`, {
			headers: { authorization: `Bearer ${secret}` },
		});
		const body = (await response.json()) as Record<string, string>;
		if (body.status !== "running") return body;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	throw new Error("run did not finish");
}

async function freePort(): Promise<number> {
	const server = createServer();
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
	if (!address || typeof address === "string") throw new Error("missing port");
	return address.port;
}

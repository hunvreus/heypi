import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import { consoleLogger, local } from "@hunvreus/heypi";
import type { Handler, HttpRoute } from "@hunvreus/heypi/adapter";

test("local adapter registers loopback dev routes on the shared HTTP listener", async () => {
	const routes: HttpRoute[] = [];
	const adapter = local();
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
			["POST", "/dev/messages", undefined, undefined],
			["POST", "/dev/threads/:threadId/messages", undefined, undefined],
			["GET", "/dev/threads/:threadId/runs/:runId", undefined, undefined],
		],
	);
});

test("local adapter accepts sync messages without provider setup", async () => {
	const port = await freePort();
	const seen: Array<{ channel: string; thread: string; text: string; actor: string }> = [];
	const statuses = new Map<string, { ok: boolean; threadId: string; runId: string; status: string; text: string }>();
	const adapter = local();
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
	const server = createServer();
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(port, "127.0.0.1", () => {
			server.off("error", reject);
			resolve();
		});
	});
	const routes: HttpRoute[] = [];
	await adapter.start({
		handler,
		status: async ({ runId }) => statuses.get(runId),
		logger: consoleLogger({ level: "error", format: "pretty" }),
		http: {
			register: (route) => routes.push(route),
		},
	});
	server.removeAllListeners("request");
	server.on("request", (req, res) => {
		const url = new URL(req.url ?? "/", "http://localhost");
		const route = routes.find((item) => item.method === req.method && pathMatches(item.path, url.pathname));
		if (!route) {
			res.writeHead(404);
			res.end();
			return;
		}
		void route.handler(req, res);
	});
	try {
		const first = await post(port, "/dev/messages", { user: "alice", text: "hello", sync: true });
		assert.equal(first.status, 200);
		assert.match(String(first.body.threadId), /^lcth_/);
		assert.equal(first.body.status, "done");
		assert.equal(first.body.text, "ok hello");
		assert.equal(seen[0].actor, "alice");

		const done = await get(port, `/dev/threads/${first.body.threadId}/runs/${first.body.runId}`);
		assert.equal(done.status, 200);
		assert.equal(done.body.text, "ok hello");

		const second = await post(port, `/dev/threads/${first.body.threadId}/messages`, {
			user: "alice",
			text: "/status",
			sync: true,
		});
		assert.equal(second.status, 200);
		assert.equal(second.body.threadId, first.body.threadId);
		assert.equal(seen[1].text, "/status");
	} finally {
		await new Promise<void>((resolve, reject) => {
			server.close((error) => (error ? reject(error) : resolve()));
		});
	}
});

test("local adapter refuses non-loopback host binding", async () => {
	const adapter = local({ host: "0.0.0.0" });
	await assert.rejects(() =>
		adapter.start({
			handler: async () => ({ text: "no" }),
			logger: consoleLogger({ level: "error", format: "pretty" }),
			http: {
				register: () => undefined,
			},
		}),
	);
});

async function post(port: number, path: string, body: Record<string, unknown>) {
	const response = await fetch(`http://127.0.0.1:${port}${path}`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});
	return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

async function get(port: number, path: string) {
	const response = await fetch(`http://127.0.0.1:${port}${path}`);
	return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

async function freePort(): Promise<number> {
	const server = createServer();
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("missing server address");
	await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
	return address.port;
}

function pathMatches(template: string | undefined, path: string): boolean {
	if (!template) return false;
	if (template === path) return true;
	const templateParts = template.split("/").filter(Boolean);
	const pathParts = path.split("/").filter(Boolean);
	if (templateParts.length !== pathParts.length) return false;
	return templateParts.every((part, index) => part.startsWith(":") || part === pathParts[index]);
}

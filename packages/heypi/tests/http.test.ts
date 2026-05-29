import assert from "node:assert/strict";
import type { ServerResponse } from "node:http";
import { test } from "node:test";
import type { Logger } from "../src/core/log.js";
import { createHttpServerRegistry } from "../src/io/http.js";

const logger: Logger = {
	debug: () => undefined,
	info: () => undefined,
	warn: () => undefined,
	error: () => undefined,
};

test("HTTP registry returns JSON 500 before response headers are sent", async () => {
	const registry = createHttpServerRegistry({ logger, listen: { host: "127.0.0.1", port: 0 } });
	registry.register({
		method: "GET",
		path: "/boom",
		handler: async () => {
			throw new Error("boom");
		},
	});
	await registry.listen();
	try {
		const response = await fetch(url(registry, "/boom"));
		assert.equal(response.status, 500);
		assert.deepEqual(await response.json(), { ok: false, error: "http route failed" });
	} finally {
		await registry.close();
	}
});

test("HTTP registry does not append JSON errors after response headers are sent", async () => {
	const registry = createHttpServerRegistry({ logger, listen: { host: "127.0.0.1", port: 0 } });
	registry.register({
		method: "GET",
		path: "/partial",
		handler: async (_req, res: ServerResponse) => {
			res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
			res.write("partial");
			throw new Error("boom");
		},
	});
	await registry.listen();
	try {
		const response = await fetch(url(registry, "/partial"));
		assert.equal(response.status, 200);
		assert.equal(await response.text(), "partial");
	} finally {
		await registry.close();
	}
});

function url(registry: ReturnType<typeof createHttpServerRegistry>, path: string): string {
	const address = registry.address();
	if (!address) throw new Error("registry is not listening");
	return `http://${address.host}:${address.port}${path}`;
}

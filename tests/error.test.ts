import assert from "node:assert/strict";
import { test } from "node:test";
import { consoleLogger, redact, userError } from "../src/core/log.js";

test("redact removes provider secrets from logged errors", () => {
	assert.equal(redact("bad key sk-proj-abc123"), "bad key sk-<redacted>");
	assert.equal(redact("bad token xoxb-abc123"), "bad token xoxb-<redacted>");
	assert.equal(redact("bad app xapp-abc123"), "bad app xapp-<redacted>");
	assert.equal(redact("bad aws AKIA1234567890ABCDEF"), "bad aws AKIA<redacted>");
	assert.equal(redact("bad jwt eyJabc.def_ghi.jkl-mno"), "bad jwt jwt:<redacted>");
});

test("user errors are generic", () => {
	assert.equal(userError("model"), "The model call failed. Check the heypi server logs.");
	assert.equal(userError("handler"), "The request failed. Check the heypi server logs.");
});

test("pretty logger writes single-line redacted fields", () => {
	const lines: string[] = [];
	const info = console.info;
	console.info = (message?: unknown) => {
		lines.push(String(message));
	};
	try {
		consoleLogger({ level: "debug", format: "pretty" }).info("model.error", {
			agent: "agent",
			error: "bad key sk-proj-abc123",
			nested: { token: "xoxb-abc123" },
			text: "hello world",
		});
	} finally {
		console.info = info;
	}
	assert.deepEqual(lines, [
		'[heypi] model.error agent=agent error="bad key sk-<redacted>" nested={"token":"xoxb-<redacted>"} text="hello world"',
	]);
});

test("json logger writes structured redacted fields", () => {
	const lines: string[] = [];
	const error = console.error;
	console.error = (message?: unknown) => {
		lines.push(String(message));
	};
	try {
		consoleLogger({ format: "json" }).error("handler.error", {
			error: "bad token xapp-abc123",
		});
	} finally {
		console.error = error;
	}
	const data = JSON.parse(lines[0] ?? "") as Record<string, unknown>;
	assert.equal(data.level, "error");
	assert.equal(data.event, "handler.error");
	assert.equal(data.error, "bad token xapp-<redacted>");
	assert.equal(typeof data.time, "string");
});

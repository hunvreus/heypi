import assert from "node:assert/strict";
import { test } from "node:test";
import { consoleLogger, redact, userError } from "../src/core/log.js";

test("redact removes provider secrets from logged errors", () => {
	const openai = "sk" + "-proj-abc123";
	const slackBot = "xoxb" + "-abc123";
	const slackApp = "xapp" + "-abc123";
	const discord = ["MTAxNTIzNDU2Nzg5MDEyMzQ1Ng", "GxYxgT", "7DqQjI3jVx-NkY8ZqX123456789"].join(".");
	const aws = "AKIA" + "1234567890ABCDEF";
	const jwt = ["eyJabc", "def_ghi", "jkl-mno"].join(".");
	assert.equal(redact(`bad key ${openai}`), "bad key sk-<redacted>");
	assert.equal(redact(`bad token ${slackBot}`), "bad token xoxb-<redacted>");
	assert.equal(redact(`bad app ${slackApp}`), "bad app xapp-<redacted>");
	assert.equal(redact(`bad discord ${discord}`), "bad discord <redacted>");
	assert.equal(redact(`bad aws ${aws}`), "bad aws AKIA<redacted>");
	assert.equal(redact(`bad jwt ${jwt}`), "bad jwt jwt:<redacted>");
});

test("user errors are generic", () => {
	assert.equal(userError(), "Something went wrong. Ask an admin to check the server logs.");
	assert.equal(userError("Custom fallback."), "Custom fallback.");
});

test("pretty logger writes single-line redacted fields", () => {
	const lines: string[] = [];
	const info = console.info;
	console.info = (message?: unknown) => {
		lines.push(String(message));
	};
	try {
		const openai = "sk" + "-proj-abc123";
		const slack = "xoxb" + "-abc123";
		consoleLogger({ level: "debug", format: "pretty" }).info("model.error", {
			agent: "agent",
			error: `bad key ${openai}`,
			nested: { token: slack },
			text: "hello world",
		});
	} finally {
		console.info = info;
	}
	assert.deepEqual(lines, [
		'[heypi] model.error agent=agent error="bad key sk-<redacted>" nested={"token":"xoxb-<redacted>"} text="hello world"',
	]);
});

test("pretty logger marks warnings and errors", () => {
	const lines: string[] = [];
	const warn = console.warn;
	const error = console.error;
	const forceColor = process.env.FORCE_COLOR;
	const noColor = process.env.NO_COLOR;
	console.warn = (message?: unknown) => {
		lines.push(String(message));
	};
	console.error = (message?: unknown) => {
		lines.push(String(message));
	};
	delete process.env.FORCE_COLOR;
	process.env.NO_COLOR = "1";
	try {
		consoleLogger({ level: "debug", format: "pretty" }).warn("jobs.disabled", { missing: "target" });
		consoleLogger({ level: "debug", format: "pretty" }).error("admin.failed", { reason: "bad" });
	} finally {
		console.warn = warn;
		console.error = error;
		if (forceColor === undefined) {
			delete process.env.FORCE_COLOR;
		} else {
			process.env.FORCE_COLOR = forceColor;
		}
		if (noColor === undefined) {
			delete process.env.NO_COLOR;
		} else {
			process.env.NO_COLOR = noColor;
		}
	}
	assert.deepEqual(lines, ["[heypi] WARN jobs.disabled missing=target", "[heypi] ERROR admin.failed reason=bad"]);
});

test("pretty logger colors warnings and errors when color is forced", () => {
	const lines: string[] = [];
	const warn = console.warn;
	const forceColor = process.env.FORCE_COLOR;
	console.warn = (message?: unknown) => {
		lines.push(String(message));
	};
	process.env.FORCE_COLOR = "1";
	try {
		consoleLogger({ level: "debug", format: "pretty" }).warn("jobs.disabled", { missing: "target" });
	} finally {
		console.warn = warn;
		if (forceColor === undefined) {
			delete process.env.FORCE_COLOR;
		} else {
			process.env.FORCE_COLOR = forceColor;
		}
	}
	assert.equal(lines[0], "\x1b[33m[heypi] WARN jobs.disabled missing=target\x1b[0m");
});

test("json logger writes structured redacted fields", () => {
	const lines: string[] = [];
	const error = console.error;
	console.error = (message?: unknown) => {
		lines.push(String(message));
	};
	try {
		const slack = "xapp" + "-abc123";
		consoleLogger({ format: "json" }).error("handler.error", {
			error: `bad token ${slack}`,
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

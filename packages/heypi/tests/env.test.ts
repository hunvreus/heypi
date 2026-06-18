import assert from "node:assert/strict";
import { test } from "node:test";
import { optionalEnv, requiredEnv } from "../src/io/env.js";

test("adapter env helpers trim optional values", () => {
	const previous = process.env.HEYPI_ENV_TEST;
	try {
		process.env.HEYPI_ENV_TEST = "  value  ";
		assert.equal(optionalEnv("HEYPI_ENV_TEST"), "value");
	} finally {
		restoreEnv("HEYPI_ENV_TEST", previous);
	}
});

test("adapter env helpers treat blank values as missing", () => {
	const previous = process.env.HEYPI_ENV_TEST;
	try {
		process.env.HEYPI_ENV_TEST = "   ";
		assert.equal(optionalEnv("HEYPI_ENV_TEST"), undefined);
		assert.throws(
			() => requiredEnv("HEYPI_ENV_TEST", "Test secret"),
			/Test secret is required; pass it explicitly or set HEYPI_ENV_TEST/,
		);
	} finally {
		restoreEnv("HEYPI_ENV_TEST", previous);
	}
});

function restoreEnv(name: string, value: string | undefined): void {
	if (value === undefined) delete process.env[name];
	else process.env[name] = value;
}

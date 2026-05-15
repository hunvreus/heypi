import assert from "node:assert/strict";
import { test } from "node:test";
import { agentFrom } from "../src/config.js";

test("agentFrom requires an explicit model or HEYPI_MODEL", () => {
	const previous = process.env.HEYPI_MODEL;
	delete process.env.HEYPI_MODEL;
	try {
		assert.throws(() => agentFrom("./examples/slack-devops/agent"), /model is required/);
	} finally {
		if (previous === undefined) delete process.env.HEYPI_MODEL;
		else process.env.HEYPI_MODEL = previous;
	}
});

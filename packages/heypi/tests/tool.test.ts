import assert from "node:assert/strict";
import { test } from "node:test";
import { Type } from "@sinclair/typebox";
import { tool } from "../src/tool.js";

test("tool wraps string results as Pi text content", async () => {
	const lookup = tool<{ service: string }>({
		name: "lookup",
		description: "Lookup a service",
		parameters: Type.Object({ service: Type.String() }),
		execute: async ({ service }) => `service=${service}`,
	});

	const out = await lookup.execute("call-1", { service: "api" }, undefined, undefined, undefined as never);
	assert.deepEqual(out, {
		content: [{ type: "text", text: "service=api" }],
		details: { tool: "lookup" },
	});
});

test("tool preserves structured Pi results", async () => {
	const lookup = tool({
		name: "lookup",
		description: "Lookup a service",
		parameters: Type.Object({}),
		execute: async () => ({ content: [{ type: "text" as const, text: "ok" }], details: { state: "done" } }),
	});

	const out = await lookup.execute("call-1", {}, undefined, undefined, undefined as never);
	assert.deepEqual(out, {
		content: [{ type: "text", text: "ok" }],
		details: { state: "done" },
	});
});

test("tool direct Pi execution fails clearly when runtime is used without heypi binding", async () => {
	const lookup = tool({
		name: "lookup",
		description: "Lookup a service",
		parameters: Type.Object({}),
		execute: async (_params, ctx) => {
			await ctx.runtime.bash?.({ command: "pwd" });
			return "ok";
		},
	});

	await assert.rejects(
		() => lookup.execute("call-1", {}, undefined, undefined, undefined as never),
		/runtime not bound; register this tool through heypi before using ctx\.runtime/,
	);
});

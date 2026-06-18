import assert from "node:assert/strict";
import { test } from "node:test";
import { Type } from "@sinclair/typebox";
import { z } from "zod";
import { splitTools } from "../src/core-tools.js";
import { defineTool } from "../src/tool.js";
import { toolConfirm } from "../src/tool-internal.js";

test("defineTool preserves structured Pi results", async () => {
	const lookup = defineTool({
		name: "lookup",
		description: "Lookup a service",
		input: Type.Object({}),
		run: async () => ({ content: [{ type: "text" as const, text: "ok" }], details: { state: "done" } }),
	});

	const out = await lookup.execute("call-1", {}, undefined, undefined, undefined as never);
	assert.deepEqual(out, {
		content: [{ type: "text", text: "ok" }],
		details: { state: "done" },
	});
});

test("defineTool direct Pi execution fails clearly when runtime is used without heypi binding", async () => {
	const lookup = defineTool({
		name: "lookup",
		description: "Lookup a service",
		input: Type.Object({}),
		run: async (_params, ctx) => {
			await ctx.runtime.bash?.({ command: "pwd" });
			return "ok";
		},
	});

	await assert.rejects(
		() => lookup.execute("call-1", {}, undefined, undefined, undefined as never),
		/runtime not bound; register this tool through heypi before using ctx\.runtime/,
	);
});

test("defineTool wraps input/run tools as Pi tools", async () => {
	const lookup = defineTool<{ service: string }>({
		name: "lookup",
		description: "Lookup a service",
		input: Type.Object({ service: Type.String() }),
		run: async ({ service }) => `service=${service}`,
	});

	const out = await lookup.execute("call-1", { service: "api" }, undefined, undefined, undefined as never);
	assert.deepEqual(out, {
		content: [{ type: "text", text: "service=api" }],
		details: { tool: "lookup" },
	});
});

test("defineTool converts Zod input schemas to JSON Schema parameters", async () => {
	const lookup = defineTool({
		name: "lookup",
		description: "Lookup a service",
		input: z.object({ service: z.string() }),
		run: async ({ service }) => `service=${service}`,
	});

	assert.deepEqual(lookup.parameters, {
		$schema: "https://json-schema.org/draft/2020-12/schema",
		type: "object",
		properties: { service: { type: "string" } },
		required: ["service"],
		additionalProperties: false,
	});
});

test("defineTool parses Zod input before run", async () => {
	const lookup = defineTool({
		name: "lookup",
		description: "Lookup a service",
		input: z.object({ count: z.number().default(1) }),
		run: async ({ count }) => `count=${count}`,
	});

	const out = await lookup.execute("call-1", {}, undefined, undefined, undefined as never);
	assert.deepEqual(out, {
		content: [{ type: "text", text: "count=1" }],
		details: { tool: "lookup" },
	});
	await assert.rejects(
		() => lookup.execute("call-2", { count: "bad" }, undefined, undefined, undefined as never),
		(error) => error instanceof z.ZodError,
	);
});

test("defineTool parses Zod input before confirm", () => {
	const lookup = defineTool({
		name: "lookup",
		description: "Lookup a service",
		input: z.object({ count: z.number().default(1) }),
		confirm: ({ count }) => ({ message: `Lookup ${count}` }),
		run: async ({ count }) => `count=${count}`,
	});
	const confirm = toolConfirm(lookup);

	assert.equal(typeof confirm, "function");
	assert.deepEqual(typeof confirm === "function" ? confirm({}) : undefined, { message: "Lookup 1" });
});

test("unnamed defineTool tools must be loaded through discovery", () => {
	const lookup = defineTool({
		description: "Lookup a service",
		input: z.object({ service: z.string() }),
		run: async ({ service }) => `service=${service}`,
	});

	assert.throws(() => splitTools([lookup]), /tool name is required unless the tool is loaded with loadTools/);
});

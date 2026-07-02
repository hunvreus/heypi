import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createFileMemoryStore, createMemoryExtension } from "../src/memory.js";

describe("memory", () => {
	it("stores and searches durable records", async () => {
		const store = createFileMemoryStore(join(tmpdir(), `heypi-memory-${Date.now()}-${Math.random()}.jsonl`));

		const first = await store.add("Use tabs in this repo.");
		await store.add("Deploy from main.");

		expect(first.id).toMatch(/^mem_/);
		await expect(store.search("tabs")).resolves.toMatchObject([{ text: "Use tabs in this repo." }]);
		await expect(store.search(undefined, 1)).resolves.toMatchObject([{ text: "Deploy from main." }]);
	});

	it("registers memory_store and memory_search tools", async () => {
		type Tool = {
			name: string;
			execute(toolCallId: string, params: unknown, signal?: AbortSignal): Promise<unknown>;
		};
		const tools = new Map<string, Tool>();
		const store = createFileMemoryStore(join(tmpdir(), `heypi-memory-tools-${Date.now()}-${Math.random()}.jsonl`));
		const extension = createMemoryExtension({ store });

		extension({
			registerTool(tool: Tool) {
				tools.set(tool.name, tool);
			},
		} as never);

		await expect(
			tools.get("memory_store")?.execute("call", { text: "Ronan prefers concise answers." }),
		).resolves.toMatchObject({ details: { text: "Ronan prefers concise answers." } });
		await expect(tools.get("memory_search")?.execute("call", { query: "concise" })).resolves.toMatchObject({
			details: { count: 1 },
		});
	});
});

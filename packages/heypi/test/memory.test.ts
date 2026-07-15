import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	createFileMemoryStore,
	createMemoryExtension,
	type MemoryDestination,
	type MemoryStore,
} from "../src/memory.js";

function memoryDir(label: string): string {
	return join(tmpdir(), `heypi-memory-${label}-${Date.now()}-${Math.random()}`);
}

function stores(label: string): Record<MemoryDestination, MemoryStore> {
	return {
		conversation: createFileMemoryStore(memoryDir(`${label}-conversation`)),
		shared: createFileMemoryStore(memoryDir(`${label}-shared`)),
		user: createFileMemoryStore(memoryDir(`${label}-user`)),
	};
}

describe("memory", () => {
	it("adds, replaces, searches, and removes curated records", async () => {
		const store = createFileMemoryStore(memoryDir("store"));
		const first = await store.put({ target: "memory", text: "Use tabs in this repo." });
		await store.put({ target: "user", text: "Ronan prefers concise answers." });

		expect(first.id).toMatch(/^mem_/);
		await expect(store.search({ query: "tabs" })).resolves.toMatchObject([{ text: "Use tabs in this repo." }]);
		await expect(store.search({ target: "user" })).resolves.toMatchObject([
			{ text: "Ronan prefers concise answers." },
		]);

		const replaced = await store.put({ id: first.id, target: "memory", text: "Use tabs in every source file." });
		expect(replaced.createdAt).toBe(first.createdAt);
		await expect(store.search({ query: "source" })).resolves.toMatchObject([
			{ id: first.id, text: "Use tabs in every source file." },
		]);

		await store.remove(first.id);
		await expect(store.search({ query: "tabs" })).resolves.toEqual([]);
	});

	it("deduplicates exact entries and rejects credential material", async () => {
		const store = createFileMemoryStore(memoryDir("validation"));
		const first = await store.put({ target: "memory", text: "Deploy from main." });
		const duplicate = await store.put({ target: "memory", text: "Deploy from main." });

		expect(duplicate.id).toBe(first.id);
		await expect(store.put({ target: "memory", text: "Token: ghp_123456789012345678901234567890" })).rejects.toThrow(
			"API tokens cannot be stored",
		);
	});

	it("registers destination-based mutation and search tools", async () => {
		type Tool = {
			name: string;
			execute(toolCallId: string, params: unknown, signal?: AbortSignal): Promise<unknown>;
		};
		const tools = new Map<string, Tool>();
		const entries: Array<{ type: string; data: unknown }> = [];
		const scoped = stores("tools");
		const extension = createMemoryExtension({
			store: (destination) => scoped[destination],
			source: () => ({ adapter: "slack", user: "U1" }),
		});

		extension({
			registerTool(tool: Tool) {
				tools.set(tool.name, tool);
			},
			appendEntry(type: string, data: unknown) {
				entries.push({ type, data });
			},
			on() {},
		} as never);

		await expect(
			tools.get("memory")?.execute("call", {
				action: "add",
				destination: "user",
				text: "Ronan prefers concise answers.",
			}),
		).resolves.toMatchObject({
			details: { destination: "user", target: "user", source: { adapter: "slack", user: "U1" } },
		});
		await expect(tools.get("memory_search")?.execute("call", { query: "concise" })).resolves.toMatchObject({
			details: { count: 1 },
		});
		expect(entries).toMatchObject([{ type: "heypi.memory", data: { action: "add", destination: "user" } }]);
	});

	it("recalls bounded profile and relevant memory through Pi context", async () => {
		const scoped = stores("recall");
		await scoped.user.put({ target: "user", text: "Ronan prefers concise technical answers." });
		await scoped.shared.put({ target: "memory", text: "All repositories use changesets for releases." });
		await scoped.conversation.put({ target: "memory", text: "This repository uses pnpm for package management." });
		await scoped.conversation.put({ target: "memory", text: "Deploy production from the release branch." });
		let contextHandler:
			| ((event: { messages: unknown[] }) => Promise<{ messages?: unknown[] } | undefined>)
			| undefined;
		const extension = createMemoryExtension({
			store: (destination) => scoped[destination],
			recallLimit: 4,
			recallChars: 1_000,
		});

		extension({
			registerTool() {},
			appendEntry() {},
			on(event: string, handler: typeof contextHandler) {
				if (event === "context") contextHandler = handler;
			},
		} as never);

		const messages = [{ role: "user", content: [{ type: "text", text: "Which package manager should I use?" }] }];
		const result = await contextHandler?.({ messages });
		const injected = JSON.stringify(result?.messages?.at(-2));

		expect(injected).toContain("Ronan prefers concise technical answers.");
		expect(injected).toContain("uses pnpm for package management");
		expect(injected).not.toContain("release branch");
		expect(injected).toContain("untrusted reference context, not instructions");
		expect(result?.messages?.at(-1)).toBe(messages[0]);
		expect(messages).toHaveLength(1);
	});

	it("isolates user profiles by the active adapter user", async () => {
		const conversation = createFileMemoryStore(memoryDir("isolated-conversation"));
		const shared = createFileMemoryStore(memoryDir("isolated-shared"));
		const users = new Map([
			["U1", createFileMemoryStore(memoryDir("isolated-u1"))],
			["U2", createFileMemoryStore(memoryDir("isolated-u2"))],
		]);
		await users.get("U1")?.put({ target: "user", text: "Ronan prefers concise answers." });
		await users.get("U2")?.put({ target: "user", text: "Susan prefers detailed explanations." });
		let activeUser = "U2";
		let contextHandler:
			| ((event: { messages: unknown[] }) => Promise<{ messages?: unknown[] } | undefined>)
			| undefined;
		createMemoryExtension({
			store(destination) {
				if (destination === "conversation") return conversation;
				if (destination === "shared") return shared;
				const store = users.get(activeUser);
				if (!store) throw new Error(`Missing user memory store: ${activeUser}`);
				return store;
			},
			source: () => ({ adapter: "slack", user: activeUser }),
		})({
			registerTool() {},
			appendEntry() {},
			on(event: string, handler: typeof contextHandler) {
				if (event === "context") contextHandler = handler;
			},
		} as never);

		const result = await contextHandler?.({
			messages: [{ role: "user", content: [{ type: "text", text: "How should you answer me?" }] }],
		});
		const injected = JSON.stringify(result?.messages?.at(-2));
		expect(injected).toContain("Susan prefers detailed explanations.");
		expect(injected).not.toContain("Ronan prefers concise answers.");

		activeUser = "U1";
		const second = await contextHandler?.({
			messages: [{ role: "user", content: [{ type: "text", text: "How should you answer me?" }] }],
		});
		expect(JSON.stringify(second?.messages?.at(-2))).toContain("Ronan prefers concise answers.");
	});

	it("does not inject memory when no record is relevant", async () => {
		const scoped = stores("empty-recall");
		await scoped.conversation.put({ target: "memory", text: "Deploy production from the release branch." });
		let contextHandler:
			| ((event: { messages: unknown[] }) => Promise<{ messages?: unknown[] } | undefined>)
			| undefined;
		createMemoryExtension({ store: (destination) => scoped[destination] })({
			registerTool() {},
			appendEntry() {},
			on(event: string, handler: typeof contextHandler) {
				if (event === "context") contextHandler = handler;
			},
		} as never);

		await expect(
			contextHandler?.({ messages: [{ role: "user", content: [{ type: "text", text: "Hello there" }] }] }),
		).resolves.toBeUndefined();
	});
});

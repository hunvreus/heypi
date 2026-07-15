import { stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ensureChatStorage, executionKey, storageFor, storageSegment, userMemoryDir } from "../src/storage.js";
import type { AgentConfig, ChatMessage } from "../src/types.js";

const message: ChatMessage = {
	id: "m1",
	adapter: "slack",
	adapterId: "workspace",
	conversation: "C123",
	thread: "1710000000.000100",
	user: { id: "U1" },
	text: "hello",
	mentioned: true,
	dm: false,
};

const agent: AgentConfig = {
	id: "agent",
	root: "/tmp/agent",
};

function makeState(): string {
	return join(tmpdir(), `heypi-storage-${Date.now()}-${Math.random().toString(36).slice(2)}`);
}

describe("chat storage", () => {
	it("keeps safe path segments readable and hashes unsafe ones", () => {
		expect(storageSegment("slack:devops_1")).toBe("slack:devops_1");
		expect(storageSegment("../secret")).toMatch(/^id-[a-f0-9]{10}$/);
		expect(storageSegment("")).toMatch(/^id-[a-f0-9]{10}$/);
	});

	it("derives adapterId, surface, and thread session paths", () => {
		const state = makeState();
		const storage = storageFor(agent, state, message);

		expect(storage.adapterDir).toBe(join(state, "adapters", "workspace"));
		expect(storage.sharedDir).toBe(join(state, "adapters", "workspace", "shared"));
		expect(storage.conversationDir).toBe(join(state, "adapters", "workspace", "conversations", "C123"));
		expect(storage.workspaceDir).toBe(join(storage.conversationDir, "workspace"));
		expect(storage.sessionDir).toBe(join(storage.conversationDir, "sessions", executionKey(message)));
		expect(storage.logPath).toBe(join(storage.sessionDir, "log.jsonl"));
		expect(storage.memoryDir).toBe(join(storage.conversationDir, "memory"));
		expect(storage.sharedMemoryDir).toBe(join(storage.sharedDir, "memory"));
		expect(userMemoryDir(storage, "U1")).toBe(join(storage.adapterDir, "users", "U1", "memory"));
		expect(storage.secretDir).toBe(join(storage.conversationDir, "secrets"));
	});

	it("uses configured runtime workspace as the workspace root", () => {
		const state = makeState();
		const workspace = join(state, "workspaces");
		const storage = storageFor({ ...agent, runtime: { workspace } }, state, message);

		expect(storage.workspaceDir).toBe(join(workspace, "workspace", "conversations", "C123"));
	});

	it("shares workspace by surface but isolates logs by execution key", () => {
		const state = makeState();
		const first = storageFor(agent, state, { ...message, thread: "1710000000.000100" });
		const second = storageFor(agent, state, { ...message, thread: "1710000000.000200" });

		expect(first.workspaceDir).toBe(second.workspaceDir);
		expect(first.logPath).not.toBe(second.logPath);
		expect(first.sessionDir).not.toBe(second.sessionDir);
	});

	it("creates storage directories", async () => {
		const storage = storageFor(agent, makeState(), message);

		await ensureChatStorage(storage);

		expect((await stat(storage.adapterDir)).isDirectory()).toBe(true);
		expect((await stat(storage.sharedDir)).isDirectory()).toBe(true);
		expect((await stat(storage.workspaceDir)).isDirectory()).toBe(true);
		expect((await stat(storage.sessionDir)).isDirectory()).toBe(true);
		expect((await stat(storage.secretDir)).isDirectory()).toBe(true);
	});
});

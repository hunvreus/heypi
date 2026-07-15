import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { AgentConfig, ChatMessage } from "./types.js";

export type ChatStorage = {
	adapterDir: string;
	sharedDir: string;
	conversationDir: string;
	workspaceDir: string;
	logPath: string;
	lockPath: string;
	sessionDir: string;
	sharedMemoryDir: string;
	memoryDir: string;
	secretDir: string;
};

export type ChatAddress = {
	adapter: string;
	adapterId: string;
	conversation: string;
	thread?: string;
};

function shortHash(value: string): string {
	return createHash("sha256").update(value).digest("hex").slice(0, 10);
}

export function storageSegment(value: string): string {
	const trimmed = value.trim();
	if (/^[a-zA-Z0-9][a-zA-Z0-9_.:-]*$/.test(trimmed) && trimmed !== "." && trimmed !== "..") return trimmed;
	return `id-${shortHash(value)}`;
}

export function executionKey(message: ChatAddress): string {
	const stream = message.thread ? `${message.conversation}:${message.thread}` : message.conversation;
	return storageSegment(`${message.adapter}:${message.adapterId}:${stream}`);
}

export function storageFor(agent: AgentConfig, stateDir: string, message: ChatMessage): ChatStorage {
	return storageForAddress(agent, stateDir, message);
}

export function storageForAddress(agent: AgentConfig, stateDir: string, message: ChatAddress): ChatStorage {
	const adapterId = storageSegment(message.adapterId);
	const conversation = storageSegment(message.conversation);
	const adapterDir = join(stateDir, "adapters", adapterId);
	const sharedDir = join(adapterDir, "shared");
	const conversationDir = join(adapterDir, "conversations", conversation);
	const workspaceRoot = agent.runtime?.workspace ? resolve(agent.runtime.workspace) : undefined;
	const workspaceDir = workspaceRoot
		? join(workspaceRoot, adapterId, "conversations", conversation)
		: join(conversationDir, "workspace");
	const sessionDir = join(conversationDir, "sessions", executionKey(message));
	return {
		adapterDir,
		sharedDir,
		conversationDir,
		workspaceDir,
		logPath: join(sessionDir, "log.jsonl"),
		lockPath: join(sessionDir, "run.lock"),
		sessionDir,
		sharedMemoryDir: join(sharedDir, "memory"),
		memoryDir: join(conversationDir, "memory"),
		secretDir: join(conversationDir, "secrets"),
	};
}

export function userMemoryDir(storage: ChatStorage, userId: string): string {
	return join(storage.adapterDir, "users", storageSegment(userId), "memory");
}

export async function ensureChatStorage(storage: ChatStorage): Promise<void> {
	await mkdir(storage.adapterDir, { recursive: true });
	await mkdir(storage.sharedDir, { recursive: true });
	await mkdir(storage.conversationDir, { recursive: true });
	await mkdir(storage.workspaceDir, { recursive: true });
	await mkdir(storage.sessionDir, { recursive: true });
	await mkdir(storage.secretDir, { recursive: true });
}

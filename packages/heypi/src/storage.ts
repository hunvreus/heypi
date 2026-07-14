import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { AgentConfig, ChatMessage } from "./types.js";

export type ChatStorage = {
	accountDir: string;
	sharedDir: string;
	surfaceDir: string;
	workspaceDir: string;
	logPath: string;
	lockPath: string;
	sessionDir: string;
	memoryPath: string;
	secretDir: string;
};

function shortHash(value: string): string {
	return createHash("sha256").update(value).digest("hex").slice(0, 10);
}

export function storageSegment(value: string): string {
	const trimmed = value.trim();
	if (/^[a-zA-Z0-9][a-zA-Z0-9_.:-]*$/.test(trimmed) && trimmed !== "." && trimmed !== "..") return trimmed;
	return `id-${shortHash(value)}`;
}

export function executionKey(message: ChatMessage): string {
	const stream = message.thread ? `${message.conversation}:${message.thread}` : message.conversation;
	return storageSegment(`${message.adapter}:${message.account}:${stream}`);
}

export function storageFor(agent: AgentConfig, stateDir: string, message: ChatMessage): ChatStorage {
	const account = storageSegment(message.account);
	const surface = storageSegment(message.conversation);
	const accountDir = join(stateDir, "accounts", account);
	const sharedDir = join(accountDir, "shared");
	const surfaceDir = join(accountDir, "channels", surface);
	const workspaceRoot = agent.runtime?.workspace ? resolve(agent.runtime.workspace) : undefined;
	const workspaceDir = workspaceRoot
		? join(workspaceRoot, account, "channels", surface)
		: join(surfaceDir, "workspace");
	const sessionDir = join(surfaceDir, "sessions", executionKey(message));
	return {
		accountDir,
		sharedDir,
		surfaceDir,
		workspaceDir,
		logPath: join(sessionDir, "log.jsonl"),
		lockPath: join(sessionDir, "run.lock"),
		sessionDir,
		memoryPath: join(surfaceDir, "memory.jsonl"),
		secretDir: join(surfaceDir, "secrets"),
	};
}

export async function ensureChatStorage(storage: ChatStorage): Promise<void> {
	await mkdir(storage.accountDir, { recursive: true });
	await mkdir(storage.sharedDir, { recursive: true });
	await mkdir(storage.surfaceDir, { recursive: true });
	await mkdir(storage.workspaceDir, { recursive: true });
	await mkdir(storage.sessionDir, { recursive: true });
	await mkdir(storage.secretDir, { recursive: true });
}

import type { Dirent } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ChannelRecord } from "./channel.js";

export type AuditConversation = {
	key: string;
	path: string;
	dir: string;
};

export type AuditPiSession = {
	id: string;
	path: string;
};

export type AuditOptions = {
	stateDir: string;
};

export async function listAuditConversations(options: AuditOptions): Promise<AuditConversation[]> {
	const root = join(options.stateDir, "adapters");
	const conversations: AuditConversation[] = [];
	try {
		for (const adapterId of await readdir(root, { withFileTypes: true })) {
			if (!adapterId.isDirectory()) continue;
			const conversationRoot = join(root, adapterId.name, "conversations");
			let surfaces: Dirent[];
			try {
				surfaces = await readdir(conversationRoot, { withFileTypes: true });
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
				throw error;
			}
			for (const surface of surfaces) {
				if (!surface.isDirectory()) continue;
				const sessionRoot = join(conversationRoot, surface.name, "sessions");
				let sessions: Dirent[];
				try {
					sessions = await readdir(sessionRoot, { withFileTypes: true });
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
					throw error;
				}
				for (const session of sessions) {
					if (!session.isDirectory()) continue;
					conversations.push({
						key: `${adapterId.name}/${surface.name}/${session.name}`,
						path: join(sessionRoot, session.name, "log.jsonl"),
						dir: join(sessionRoot, session.name),
					});
				}
			}
		}
		return conversations.sort((a, b) => a.key.localeCompare(b.key));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	}
}

export async function readAuditConversationKey(
	options: AuditOptions,
	key: string,
): Promise<ChannelRecord[] | undefined> {
	const conversation = (await listAuditConversations(options)).find((entry) => entry.key === key);
	if (!conversation) return undefined;
	return readAuditConversation(conversation.path);
}

export async function listAuditPiSessions(options: AuditOptions, key: string): Promise<AuditPiSession[] | undefined> {
	const conversation = (await listAuditConversations(options)).find((entry) => entry.key === key);
	if (!conversation) return undefined;
	const sessions: AuditPiSession[] = [];
	await collectJsonl(conversation.dir, conversation.dir, sessions);
	return sessions.filter((session) => session.id !== "log.jsonl").sort((a, b) => a.id.localeCompare(b.id));
}

export async function readAuditPiSession(options: AuditOptions, key: string, id: string): Promise<string | undefined> {
	const sessions = await listAuditPiSessions(options, key);
	const session = sessions?.find((entry) => entry.id === id);
	if (!session) return undefined;
	return readFile(session.path, "utf8");
}

export async function readAuditConversation(path: string): Promise<ChannelRecord[]> {
	const text = await readFile(path, "utf8");
	return text
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line) as ChannelRecord);
}

async function collectJsonl(root: string, dir: string, out: AuditPiSession[]): Promise<void> {
	let entries: Dirent[];
	try {
		entries = await readdir(dir, { withFileTypes: true });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
		throw error;
	}
	for (const entry of entries) {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) {
			await collectJsonl(root, path, out);
			continue;
		}
		if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
		out.push({ id: path.slice(root.length + 1), path });
	}
}

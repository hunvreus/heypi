import type { Dirent } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ChannelRecord } from "./channel.js";

export type AuditConversation = {
	key: string;
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

export async function readAuditConversationKey(options: AuditOptions, key: string): Promise<ChannelRecord[] | undefined> {
	const conversation = (await listAuditConversations(options)).find((entry) => entry.key === key);
	if (!conversation) return undefined;
	return readAuditConversation(conversation.path);
}

export async function readAuditConversation(path: string): Promise<ChannelRecord[]> {
	const text = await readFile(path, "utf8");
	return text
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line) as ChannelRecord);
}

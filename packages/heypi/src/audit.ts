import type { Dirent } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ChannelRecord } from "./channel.js";

export type AuditChannel = {
	key: string;
	path: string;
};

export type AuditOptions = {
	stateDir: string;
};

export async function listAuditChannels(options: AuditOptions): Promise<AuditChannel[]> {
	const root = join(options.stateDir, "accounts");
	const channels: AuditChannel[] = [];
	try {
		for (const account of await readdir(root, { withFileTypes: true })) {
			if (!account.isDirectory()) continue;
			const channelRoot = join(root, account.name, "channels");
			let surfaces: Dirent[];
			try {
				surfaces = await readdir(channelRoot, { withFileTypes: true });
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
				throw error;
			}
			for (const surface of surfaces) {
				if (!surface.isDirectory()) continue;
				const sessionRoot = join(channelRoot, surface.name, "sessions");
				let sessions: Dirent[];
				try {
					sessions = await readdir(sessionRoot, { withFileTypes: true });
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
					throw error;
				}
				for (const session of sessions) {
					if (!session.isDirectory()) continue;
					channels.push({
						key: `${account.name}/${surface.name}/${session.name}`,
						path: join(sessionRoot, session.name, "log.jsonl"),
					});
				}
			}
		}
		return channels.sort((a, b) => a.key.localeCompare(b.key));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	}
}

export async function readAuditChannelKey(options: AuditOptions, key: string): Promise<ChannelRecord[] | undefined> {
	const channel = (await listAuditChannels(options)).find((entry) => entry.key === key);
	if (!channel) return undefined;
	return readAuditChannel(channel.path);
}

export async function readAuditChannel(path: string): Promise<ChannelRecord[]> {
	const text = await readFile(path, "utf8");
	return text
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line) as ChannelRecord);
}

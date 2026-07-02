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
	const root = join(options.stateDir, "channels");
	try {
		const entries = await readdir(root, { withFileTypes: true });
		return entries
			.filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
			.map((entry) => ({
				key: entry.name.slice(0, -".jsonl".length),
				path: join(root, entry.name),
			}))
			.sort((a, b) => a.key.localeCompare(b.key));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	}
}

export async function readAuditChannel(path: string): Promise<ChannelRecord[]> {
	const text = await readFile(path, "utf8");
	return text
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line) as ChannelRecord);
}

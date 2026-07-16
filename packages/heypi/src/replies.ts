import { appendFile, mkdir, readFile, truncate } from "node:fs/promises";
import { dirname } from "node:path";

type ReplyRecord = {
	message: string;
	session: string;
};

export type ReplyIndex = {
	load(): Promise<void>;
	resolve(message: string): string | undefined;
	add(message: string, session: string): Promise<void>;
};

/** Persist platform reply IDs that resume a logical public conversation. */
export function createReplyIndex(path: string): ReplyIndex {
	const sessions = new Map<string, string>();
	let writes = Promise.resolve();

	return {
		async load() {
			await mkdir(dirname(path), { recursive: true });
			const text = await readFile(path, "utf8").catch((error: NodeJS.ErrnoException) => {
				if (error.code === "ENOENT") return "";
				throw error;
			});
			const lines = text.split("\n");
			let truncated = false;
			for (const [position, line] of lines.entries()) {
				if (!line) continue;
				let record: ReplyRecord;
				try {
					record = JSON.parse(line) as ReplyRecord;
				} catch (error) {
					if (position === lines.length - 1 && !text.endsWith("\n")) {
						truncated = true;
						continue;
					}
					throw error;
				}
				if (typeof record.message !== "string" || typeof record.session !== "string") continue;
				sessions.set(record.message, record.session);
			}
			if (truncated) {
				const valid = text.slice(0, text.lastIndexOf("\n") + 1);
				await truncate(path, Buffer.byteLength(valid));
			}
		},
		resolve(message) {
			return sessions.get(message);
		},
		add(message, session) {
			if (sessions.get(message) === session) return writes;
			const record: ReplyRecord = { message, session };
			const write = writes.then(async () => {
				if (sessions.get(message) === session) return;
				await appendFile(path, `${JSON.stringify(record)}\n`, "utf8");
				sessions.set(message, session);
			});
			writes = write.catch(() => undefined);
			return write;
		},
	};
}

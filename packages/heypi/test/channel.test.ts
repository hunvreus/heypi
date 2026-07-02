import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createChannel } from "../src/channel.js";
import type { ChatMessage } from "../src/types.js";

function message(id: string, text: string, mentioned = true): ChatMessage {
	return {
		id,
		adapter: "local",
		account: "test",
		conversation: "room",
		user: { id: "u1", name: "Ronan" },
		text,
		mentioned,
		dm: false,
	};
}

describe("channel", () => {
	it("queues only triggering user messages and builds current prompt", async () => {
		const logPath = join(tmpdir(), `heypi-channel-${Date.now()}-${Math.random()}.jsonl`);
		const channel = createChannel({ logPath });
		await channel.load();

		await expect(channel.ingest(message("a", "not for you", false))).resolves.toBe(false);
		await expect(channel.ingest(message("b", "help me"))).resolves.toBe(true);

		const turn = channel.next();
		expect(turn?.messageId).toBe("b");
		expect(turn?.prompt).toContain("[uid:u1] Ronan: help me");
		expect(turn?.prompt).not.toContain("not for you");
	});

	it("uses normalized chat thread ids as reply targets", async () => {
		const logPath = join(tmpdir(), `heypi-channel-thread-${Date.now()}-${Math.random()}.jsonl`);
		const channel = createChannel({ logPath });
		await channel.load();

		await channel.ingest({ ...message("reply", "threaded"), thread: "root" });

		const turn = channel.next();
		expect(turn?.messageId).toBe("root");
		expect(channel.activeMessageId()).toBe("root");
	});

	it("can build delta prompts since the last completed trigger", async () => {
		const logPath = join(tmpdir(), `heypi-channel-delta-${Date.now()}-${Math.random()}.jsonl`);
		const channel = createChannel({ logPath, context: { mode: "delta" } });
		await channel.load();

		await channel.ingest(message("a", "first trigger"));
		channel.next();
		await channel.complete("done");
		await expect(channel.ingest(message("b", "ambient follow-up", false))).resolves.toBe(false);
		await expect(channel.ingest(message("c", "second trigger"))).resolves.toBe(true);

		const turn = channel.next();
		expect(turn?.messageId).toBe("c");
		expect(turn?.prompt).not.toContain("first trigger");
		expect(turn?.prompt).toContain("ambient follow-up");
		expect(turn?.prompt).toContain("second trigger");
	});

	it("keeps only adapter coordination records", async () => {
		const logPath = join(tmpdir(), `heypi-channel-log-${Date.now()}-${Math.random()}.jsonl`);
		const channel = createChannel({ logPath });
		await channel.load();
		await channel.ingest(message("a", "hello"));
		channel.next();
		await channel.complete("done");

		const records = (await readFile(logPath, "utf8"))
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line) as { type: string });
		expect(records.map((record) => record.type)).toEqual(["inbound", "turn_queued", "turn_completed"]);
	});

	it("restores queued turns after reload", async () => {
		const logPath = join(tmpdir(), `heypi-channel-restore-${Date.now()}-${Math.random()}.jsonl`);
		const first = createChannel({ logPath });
		await first.load();
		await first.ingest(message("a", "hello"));

		const second = createChannel({ logPath });
		await second.load();

		const turn = second.next();
		expect(turn?.messageId).toBe("a");
		expect(turn?.prompt).toContain("hello");
	});
});

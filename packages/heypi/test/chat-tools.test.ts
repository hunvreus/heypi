import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createChannel } from "../src/channel.js";
import { createChatHistoryTool, createChatReplyTool } from "../src/chat-tools.js";
import type { ChatMessage } from "../src/types.js";

function message(id: string, text: string): ChatMessage {
	return {
		id,
		adapter: "local",
		account: "test",
		conversation: "room",
		user: { id: "u1", name: "Ronan" },
		text,
		mentioned: true,
		dm: false,
	};
}

describe("chat tools", () => {
	it("searches older channel history explicitly", async () => {
		const channel = createChannel({ logPath: join(tmpdir(), `heypi-history-${Date.now()}-${Math.random()}.jsonl`) });
		await channel.load();
		await channel.ingest(message("a", "first thing"));
		await channel.ingest(message("b", "second thing"));

		const tool = createChatHistoryTool(channel);
		const result = await tool.execute("call", { query: "second" }, undefined, undefined, {} as never);

		expect(result.content).toEqual([{ type: "text", text: "- [record:3] [uid:u1] Ronan: second thing" }]);
		expect(result.details).toEqual({ count: 1 });
	});

	it("sends sparse progress updates", async () => {
		const sent: string[] = [];
		const tool = createChatReplyTool(async (text) => {
			sent.push(text);
		});

		const result = await tool.execute("call", { text: "Working on it" }, undefined, undefined, {} as never);

		expect(sent).toEqual(["Working on it"]);
		expect(result.details).toEqual({ sent: true });
	});
});

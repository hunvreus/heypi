import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createChannel } from "../src/channel.js";
import { createChatHistoryTool, createChatRequestSecretTool } from "../src/chat-tools.js";
import { createSecretExchange } from "../src/secrets.js";
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

	it("does not return the active trigger as older history", async () => {
		const channel = createChannel({
			logPath: join(tmpdir(), `heypi-active-history-${Date.now()}-${Math.random()}.jsonl`),
		});
		await channel.load();
		await channel.ingest(message("a", "already discussed"));
		channel.next();
		await channel.complete("done");
		await channel.ingest(message("b", "current request"));
		channel.next();

		const tool = createChatHistoryTool(channel);
		const result = await tool.execute("call", {}, undefined, undefined, {} as never);

		expect(result.content).toEqual([{ type: "text", text: "- [record:1] [uid:u1] Ronan: already discussed" }]);
		expect(result.details).toEqual({ count: 1 });
	});

	it("requests encrypted secrets in the active chat target", async () => {
		const sent: unknown[] = [];
		const exchange = createSecretExchange();
		const tool = createChatRequestSecretTool({
			exchange,
			target: () => ({ conversation: "room", thread: "thread-1" }),
			async send(message) {
				sent.push(message);
			},
		});

		const result = await tool.execute(
			"call",
			{ name: "github-token", description: "GitHub token for creating pull requests" },
			undefined,
			undefined,
			{} as never,
		);

		expect(sent).toEqual([
			{
				conversation: "room",
				thread: "thread-1",
				text: expect.stringContaining("Secret requested: GitHub token for creating pull requests"),
			},
		]);
		expect((sent[0] as { text: string }).text).toContain("https://pi.dev/secret#");
		expect(result.content).toEqual([
			{
				type: "text",
				text: "Secret request sent. Wait for the user to paste the encrypted reply. It will be stored at .secrets/github-token.",
			},
		]);
	});
});

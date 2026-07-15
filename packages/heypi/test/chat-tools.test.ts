import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createChannel } from "../src/channel.js";
import { createChatAttachTool, createChatHistoryTool, createChatRequestSecretTool } from "../src/chat-tools.js";
import { createSecretManager } from "../src/secrets.js";
import type { ChatMessage } from "../src/types.js";

function message(id: string, text: string): ChatMessage {
	return {
		id,
		adapter: "local",
		adapterId: "test",
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

		expect(result.content).toEqual([
			{ type: "text", text: expect.stringMatching(/^- \[[^\]]+\] \[uid:u1\] Ronan: second thing$/) },
		]);
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

		expect(result.content).toEqual([
			{ type: "text", text: expect.stringMatching(/^- \[[^\]]+\] \[uid:u1\] Ronan: already discussed$/) },
		]);
		expect(result.details).toEqual({ count: 1 });
	});

	it("sends workspace files as attachment references", async () => {
		const workspaceDir = join(tmpdir(), `heypi-attach-${Date.now()}-${Math.random()}`);
		await mkdir(workspaceDir, { recursive: true });
		await writeFile(join(workspaceDir, "report.txt"), "hello");
		const sent: unknown[] = [];
		const tool = createChatAttachTool({
			workspaceDir,
			target: () => ({ conversation: "room" }),
			async send(message) {
				sent.push(message);
			},
		});

		const result = await tool.execute(
			"call",
			{ paths: ["report.txt"], text: "Here is the report." },
			undefined,
			undefined,
			{} as never,
		);

		expect(sent).toEqual([
			{
				conversation: "room",
				text: "Here is the report.",
				attachments: [
					{
						name: "report.txt",
						path: "report.txt",
						localPath: join(workspaceDir, "report.txt"),
						mime: "text/plain",
					},
				],
			},
		]);
		expect(result.content).toEqual([{ type: "text", text: "Attachment sent: report.txt (report.txt)" }]);
		expect(result.details).toEqual({ attachments: [{ name: "report.txt", path: "report.txt", mime: "text/plain" }] });
	});

	it("sends multiple workspace files as attachments", async () => {
		const workspaceDir = join(tmpdir(), `heypi-attach-many-${Date.now()}-${Math.random()}`);
		await mkdir(workspaceDir, { recursive: true });
		await writeFile(join(workspaceDir, "report.txt"), "hello");
		await writeFile(join(workspaceDir, "chart.png"), "png");
		const sent: unknown[] = [];
		const tool = createChatAttachTool({
			workspaceDir,
			target: () => ({ conversation: "room" }),
			async send(message) {
				sent.push(message);
			},
		});

		const result = await tool.execute(
			"call",
			{ paths: ["report.txt", "chart.png"], text: "Files attached." },
			undefined,
			undefined,
			{} as never,
		);

		expect(sent).toEqual([
			{
				conversation: "room",
				text: "Files attached.",
				attachments: [
					{
						name: "report.txt",
						path: "report.txt",
						localPath: join(workspaceDir, "report.txt"),
						mime: "text/plain",
					},
					{ name: "chart.png", path: "chart.png", localPath: join(workspaceDir, "chart.png"), mime: "image/png" },
				],
			},
		]);
		expect(result.content).toEqual([
			{ type: "text", text: "Attachment sent: report.txt (report.txt), chart.png (chart.png)" },
		]);
	});

	it("sends shared files as attachment references", async () => {
		const root = join(tmpdir(), `heypi-attach-shared-${Date.now()}-${Math.random()}`);
		const workspaceDir = join(root, "workspace");
		const sharedDir = join(root, "shared");
		await mkdir(sharedDir, { recursive: true });
		await mkdir(workspaceDir, { recursive: true });
		await writeFile(join(sharedDir, "summary.txt"), "hello");
		const sent: unknown[] = [];
		const tool = createChatAttachTool({
			workspaceDir,
			sharedDir,
			target: () => ({ conversation: "room" }),
			async send(message) {
				sent.push(message);
			},
		});

		const result = await tool.execute("call", { paths: ["/shared/summary.txt"] }, undefined, undefined, {} as never);

		expect(sent).toEqual([
			{
				conversation: "room",
				text: "Attached summary.txt.",
				attachments: [
					{
						name: "summary.txt",
						path: "/shared/summary.txt",
						localPath: join(sharedDir, "summary.txt"),
						mime: "text/plain",
					},
				],
			},
		]);
		expect(result.content).toEqual([{ type: "text", text: "Attachment sent: summary.txt (/shared/summary.txt)" }]);
	});

	it("rejects attachments outside the workspace", async () => {
		const workspaceDir = join(tmpdir(), `heypi-attach-escape-${Date.now()}-${Math.random()}`);
		await mkdir(workspaceDir, { recursive: true });
		const tool = createChatAttachTool({
			workspaceDir,
			target: () => ({ conversation: "room" }),
			async send() {},
		});

		await expect(
			tool.execute("call", { paths: ["../secret.txt"] }, undefined, undefined, {} as never),
		).rejects.toThrow("path escapes runtime workspace");
	});

	it("requests secrets without returning the raw value to the model", async () => {
		const root = join(tmpdir(), `heypi-secret-tool-${Date.now()}-${Math.random()}`);
		const sent: unknown[] = [];
		const tool = createChatRequestSecretTool({
			secretDir: join(root, "secrets"),
			manager: createSecretManager({ keyPath: join(root, "secrets.key"), pageUrl: "https://heypi.dev/secret" }),
			target: () => ({ conversation: "room" }),
			async send(message) {
				sent.push(message);
			},
		});

		const result = await tool.execute(
			"call",
			{ name: "github-token", description: "GitHub token" },
			undefined,
			undefined,
			{} as never,
		);

		expect(sent).toEqual([
			{
				conversation: "room",
				text: expect.stringContaining("https://heypi.dev/secret#"),
			},
		]);
		const content = result.content[0];
		expect(content?.type).toBe("text");
		if (content?.type !== "text") throw new Error("Expected a text tool result.");
		expect(content.text).toContain("Secret request sent");
		expect(content.text).not.toContain("ghp_");
	});
});

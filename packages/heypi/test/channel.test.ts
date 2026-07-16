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
		adapterId: "test",
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

		await expect(channel.ingest(message("a", "not for you", false))).resolves.toEqual({ action: "ignored" });
		await expect(channel.ingest(message("b", "help me"))).resolves.toMatchObject({ action: "started" });

		const turn = channel.next();
		expect(turn?.replyThread).toBeUndefined();
		expect(turn?.prompt).toContain("[uid:u1] Ronan: help me");
		expect(turn?.prompt).not.toContain("not for you");
	});

	it("does not queue empty direct messages without attachments", async () => {
		const logPath = join(tmpdir(), `heypi-channel-empty-${Date.now()}-${Math.random()}.jsonl`);
		const channel = createChannel({ logPath });
		await channel.load();

		await expect(
			channel.ingest({
				...message("empty", "", false),
				dm: true,
				mentioned: false,
			}),
		).resolves.toEqual({ action: "ignored" });

		expect(channel.next()).toBeUndefined();
	});

	it("records outbound messages with attachments", async () => {
		const logPath = join(tmpdir(), `heypi-channel-outbound-${Date.now()}.jsonl`);
		const channel = createChannel({ logPath });
		await channel.load();
		await channel.outbound(
			{
				conversation: "room",
				text: "Report attached.",
				attachments: [{ name: "report.txt", path: "report.txt", mime: "text/plain" }],
			},
			"remote-1",
		);

		const records = (await readFile(logPath, "utf8"))
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line));
		expect(records).toEqual([
			{
				type: "message_outbound",
				record: 1,
				message: "remote-1",
				time: expect.any(String),
				conversation: "room",
				text: "Report attached.",
				attachments: [{ name: "report.txt", path: "report.txt", mime: "text/plain" }],
			},
		]);
	});

	it("records approval requests and resolutions", async () => {
		const logPath = join(tmpdir(), `heypi-channel-approval-${Date.now()}.jsonl`);
		const channel = createChannel({ logPath });
		await channel.load();

		const requested = await channel.approvalRequested({
			approvalId: "a1",
			turnId: "t1",
			triggerRecord: 1,
			toolCallId: "call-1",
			toolName: "bash",
			inputHash: "hash",
			displayedAction: "git push",
			policyReason: "Run bash command.",
			actor: { id: "u1", name: "Ronan" },
			adapter: "local",
			adapterId: "local",
			conversation: "room",
		});
		const resolved = await channel.approvalResolved({
			approvalId: "a1",
			decision: "approved",
			source: "adapter_click",
			approver: { id: "admin", name: "Admin" },
			remoteMessageIds: ["remote-1"],
		});

		expect(requested).toMatchObject({ type: "approval_requested", record: 1, approvalId: "a1" });
		expect(resolved).toMatchObject({ type: "approval_resolved", record: 2, approvalId: "a1" });
		const records = (await readFile(logPath, "utf8"))
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line));
		expect(records).toMatchObject([
			{ type: "approval_requested", approvalId: "a1", inputHash: "hash" },
			{ type: "approval_resolved", approvalId: "a1", decision: "approved" },
		]);
	});

	it("queues attachment-only direct messages", async () => {
		const logPath = join(tmpdir(), `heypi-channel-attachment-${Date.now()}-${Math.random()}.jsonl`);
		const channel = createChannel({ logPath });
		await channel.load();

		await expect(
			channel.ingest({
				...message("attachment", "", false),
				dm: true,
				mentioned: false,
				attachments: [{ id: "F1", name: "file.txt" }],
			}),
		).resolves.toMatchObject({ action: "started" });

		expect(channel.next()?.prompt).toContain("attachments:");
	});

	it("uses normalized chat thread ids as reply targets", async () => {
		const logPath = join(tmpdir(), `heypi-channel-thread-${Date.now()}-${Math.random()}.jsonl`);
		const channel = createChannel({ logPath });
		await channel.load();

		await channel.ingest({ ...message("reply", "threaded"), thread: "root" });

		const turn = channel.next();
		expect(turn?.replyThread).toBe("root");
		expect(channel.activeMessageId()).toBe("root");
	});

	it("queues unmentioned follow-ups in a previously triggered thread", async () => {
		const logPath = join(tmpdir(), `heypi-channel-followup-${Date.now()}-${Math.random()}.jsonl`);
		const channel = createChannel({ logPath });
		await channel.load();

		await expect(channel.ingest({ ...message("root", "first"), thread: "root" })).resolves.toMatchObject({
			action: "started",
		});
		channel.next();
		await channel.complete("done");
		await expect(
			channel.ingest({ ...message("reply", "continue", false), session: "root", thread: "root" }),
		).resolves.toMatchObject({
			action: "started",
		});

		const turn = channel.next();
		expect(turn?.replyThread).toBe("root");
		expect(turn?.prompt).toContain("continue");
		expect(turn?.prompt).not.toContain("first");
	});

	it("ignores unmentioned messages in unrelated threads", async () => {
		const logPath = join(tmpdir(), `heypi-channel-unrelated-followup-${Date.now()}-${Math.random()}.jsonl`);
		const channel = createChannel({ logPath });
		await channel.load();

		await expect(channel.ingest({ ...message("reply", "not for bot", false), thread: "other" })).resolves.toEqual({
			action: "ignored",
		});

		expect(channel.next()).toBeUndefined();
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
		expect(records.map((record) => record.type)).toEqual(["message_inbound", "turn_queued", "turn_completed"]);
	});

	it("marks queued turns interrupted after reload", async () => {
		const logPath = join(tmpdir(), `heypi-channel-restore-${Date.now()}-${Math.random()}.jsonl`);
		const first = createChannel({ logPath });
		await first.load();
		await first.ingest(message("a", "hello"));

		const second = createChannel({ logPath });
		await second.load();

		expect(second.next()).toBeUndefined();

		const records = (await readFile(logPath, "utf8"))
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line) as { type: string; error?: string });
		expect(records.map((record) => record.type)).toEqual(["message_inbound", "turn_queued", "turn_failed"]);
		expect(records.at(-1)?.error).toBe("interrupted by restart");
	});

	it("prevents two channel handles from owning the same lock", async () => {
		const root = join(tmpdir(), `heypi-channel-lock-${Date.now()}-${Math.random()}`);
		const logPath = join(root, "log.jsonl");
		const lockPath = join(root, "run.lock");
		const first = createChannel({ logPath, lockPath });
		await first.load();

		const second = createChannel({ logPath, lockPath });
		await expect(second.load()).rejects.toThrow("channel is already active");

		await first.close();
		await expect(second.load()).resolves.toBeUndefined();
		await second.close();
	});

	it("returns deterministic queue, steer, and reject outcomes while busy", async () => {
		const logPath = join(tmpdir(), `heypi-channel-busy-${Date.now()}-${Math.random()}.jsonl`);
		const channel = createChannel({ logPath });
		await channel.load();

		await channel.ingest(message("first", "first task"));
		channel.next();

		await expect(channel.ingest(message("queued", "queue this"), "queue")).resolves.toMatchObject({
			action: "queued",
		});
		await expect(channel.ingest(message("steer", "change direction"), "steer")).resolves.toMatchObject({
			action: "steer",
			prompt: expect.stringContaining("change direction"),
		});
		await expect(channel.ingest(message("reject", "do not queue"), "reject")).resolves.toEqual({
			action: "rejected",
		});

		expect(channel.jobs().map((job) => job.state)).toEqual(["running", "queued"]);
	});

	it("records active turn cancellation", async () => {
		const logPath = join(tmpdir(), `heypi-channel-cancel-active-${Date.now()}-${Math.random()}.jsonl`);
		const channel = createChannel({ logPath });
		await channel.load();

		await channel.ingest(message("a", "first"));
		channel.next();

		await expect(channel.cancelActive("user canceled")).resolves.toBe(true);
		expect(channel.jobs()).toEqual([]);

		const records = (await readFile(logPath, "utf8"))
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line) as { type: string; reason?: string });
		expect(records.map((record) => record.type)).toEqual(["message_inbound", "turn_queued", "turn_canceled"]);
		expect(records.at(-1)?.reason).toBe("user canceled");
	});

	it("returns queued trusted jobs so their owners can settle them", async () => {
		const logPath = join(tmpdir(), `heypi-channel-cancel-trusted-${Date.now()}-${Math.random()}.jsonl`);
		const channel = createChannel({ logPath });
		await channel.load();
		await channel.ingest(message("active", "first"));
		channel.next();
		await channel.trigger({
			adapter: "local",
			adapterId: "test",
			conversation: "room",
			prompt: "Scheduled work.",
			actor: { id: "schedule:daily" },
			cause: {
				kind: "schedule",
				scheduleId: "daily",
				runId: "run-1",
				scheduledFor: "2026-07-14T09:00:00.000Z",
			},
		});

		await expect(channel.cancelQueued("application stopped")).resolves.toMatchObject([
			{
				state: "queued",
				cause: { kind: "schedule", scheduleId: "daily", runId: "run-1" },
			},
		]);
	});
});

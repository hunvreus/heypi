import { describe, expect, it } from "vitest";
import {
	approval,
	approvalActorAllowed,
	classifyCommand,
	createApprovalExtension,
	inputHash,
	renderApprovalMessage,
	settleApproval,
} from "../src/approval.js";
import type { ApprovalRequestedRecord, ApprovalResolvedRecord } from "../src/channel.js";
import type { ApprovalContext } from "../src/types.js";

function context(input: Partial<ApprovalContext> = {}): ApprovalContext {
	return {
		toolName: "bash",
		input: {},
		approvedTools: new Set(),
		...input,
	};
}

describe("renderApprovalMessage", () => {
	it("renders the message layout as a compact list", () => {
		expect(
			renderApprovalMessage({
				id: "abc",
				reason: "Run bash command.",
				command: "git push",
				requestedBy: "@Ronan",
				resolvedBy: "@Ronan",
				state: "approved",
				showId: true,
			}),
		).toBe(
			[
				"*Approved*",
				"- Reason: Run bash command.",
				"- Command:\n```\ngit push\n```",
				"- Approval ID: abc",
				"- Requested by: @Ronan",
				"- Approved by: @Ronan",
			].join("\n"),
		);
	});
});

describe("approval settlement", () => {
	it("resolves a claimed decision when its platform update fails", async () => {
		let pending = true;
		let resolved = false;
		let updateError: unknown;
		const timer = setTimeout(() => undefined, 10_000);

		await expect(
			settleApproval({
				claim: () => {
					if (!pending) return false;
					pending = false;
					return true;
				},
				timer,
				update: async () => {
					throw new Error("annotation failed");
				},
				updateFailed: (error) => {
					updateError = error;
				},
				resolve: () => {
					resolved = true;
				},
			}),
		).resolves.toBe(true);
		expect(resolved).toBe(true);
		expect(updateError).toEqual(new Error("annotation failed"));
	});
});

describe("approval policies", () => {
	it("classifies command risk", () => {
		expect(classifyCommand("git status").risk).toBe("allow");
		expect(classifyCommand("git push").risk).toBe("approval");
		expect(classifyCommand("rm -rf /").risk).toBe("block");
	});

	it("allows command policy overrides", () => {
		expect(classifyCommand("curl https://example.com", { allow: [/^curl https:\/\/example\.com$/] }).risk).toBe(
			"allow",
		);
		expect(classifyCommand("echo ok", { approve: [/^echo/] }).risk).toBe("approval");
		expect(classifyCommand("git status", { block: [/^git/] }).risk).toBe("block");
	});

	it("turns risky bash commands into approval requests", async () => {
		expect(await approval.command()(context({ input: { command: "git push" } }))).toMatchObject({
			type: "approve",
			reason: "Run bash command.",
			command: "git push",
		});
		expect(await approval.command()(context({ input: { command: "git status" } }))).toBe(false);
		expect(await approval.command()(context({ input: { command: "rm -rf /" } }))).toMatchObject({
			type: "block",
		});
	});

	it("supports context-aware predicates", async () => {
		const policy = approval.when(
			({ actor }) => actor?.id !== "admin",
			({ toolName }) => `Approve ${toolName}.`,
		);
		expect(await policy(context({ actor: { id: "admin" } }))).toBe(false);
		expect(await policy(context({ actor: { id: "user" } }))).toEqual({
			type: "approve",
			reason: "Approve bash.",
		});
	});

	it("passes tool input and request metadata to programmable policies", async () => {
		const policy = approval.when(
			({ actor, conversation, input, toolName }) =>
				toolName === "bash" &&
				actor?.id === "u1" &&
				conversation === "c1" &&
				(input as { command?: string }).command === "git push",
			"Push changes.",
		);
		expect(
			await policy(
				context({
					input: { command: "git push" },
					adapter: "slack",
					adapterId: "workspace",
					conversation: "c1",
					thread: "t1",
					actor: { id: "u1", name: "Ronan" },
				}),
			),
		).toEqual({ type: "approve", reason: "Push changes." });
	});

	it("supports once-per-tool approval", async () => {
		const approvedTools = new Set<string>();
		const policy = approval.once();
		expect(await policy(context({ approvedTools }))).toEqual({
			type: "approve",
			reason: "Run bash tool.",
		});
		approvedTools.add("bash");
		expect(await policy(context({ approvedTools }))).toBe(false);
	});

	it("matches admins and approvers before an adapter consumes a click", () => {
		expect(approvalActorAllowed({ approved: true, resolvedById: "anyone" })).toBe(true);
		expect(approvalActorAllowed({ approved: true, resolvedById: "admin" }, undefined, { users: ["admin"] })).toBe(
			true,
		);
		expect(
			approvalActorAllowed(
				{ approved: true, resolvedById: "user", roles: ["maintainer"] },
				{ roles: ["maintainer"] },
				undefined,
			),
		).toBe(true);
		expect(approvalActorAllowed({ approved: true, resolvedById: "user" }, { users: ["admin"] }, undefined)).toBe(
			false,
		);
	});

	it("hashes equivalent object inputs deterministically", () => {
		expect(inputHash({ b: 2, a: 1 })).toBe(inputHash({ a: 1, b: 2 }));
		expect(inputHash({ a: 1 })).not.toBe(inputHash({ a: 2 }));
	});
});

describe("createApprovalExtension", () => {
	it("does not require approval when no policy is supplied", async () => {
		type ToolCall = { toolName: string; input: unknown };
		type ToolHandler = (toolCall: ToolCall) => unknown | Promise<unknown>;
		let handler: ToolHandler | undefined;
		const extension = createApprovalExtension({
			async request() {
				return { approved: false };
			},
		});

		extension({
			on(event: string, next: ToolHandler) {
				if (event === "tool_call") handler = next;
			},
		} as never);

		expect(await handler?.({ toolName: "bash", input: { command: "git push" } })).toBeUndefined();
		expect(await handler?.({ toolName: "bash", input: { command: "git status" } })).toBeUndefined();
	});

	it("uses per-tool approval declarations", async () => {
		type ToolCall = { toolName: string; input: unknown };
		type ToolHandler = (toolCall: ToolCall) => unknown | Promise<unknown>;
		let handler: ToolHandler | undefined;
		const extension = createApprovalExtension({
			approvers: { users: ["u1"] },
			policies: {
				bash: approval.command(),
			},
			async request() {
				return { approved: true, resolvedById: "u1" };
			},
		});

		extension({
			on(event: string, next: ToolHandler) {
				if (event === "tool_call") handler = next;
			},
		} as never);

		expect(await handler?.({ toolName: "bash", input: { command: "git push" } })).toBeUndefined();
		expect(await handler?.({ toolName: "edit", input: { path: "x" } })).toBeUndefined();
	});

	it("blocks approval from non-approvers", async () => {
		type ToolCall = { toolName: string; input: unknown };
		type ToolHandler = (toolCall: ToolCall) => unknown | Promise<unknown>;
		let handler: ToolHandler | undefined;
		const extension = createApprovalExtension({
			approvers: { users: ["admin"] },
			policies: {
				bash: () => ({
					type: "approve",
					reason: "Run bash.",
				}),
			},
			async request() {
				return { approved: true, resolvedById: "other" };
			},
		});

		extension({
			on(event: string, next: ToolHandler) {
				if (event === "tool_call") handler = next;
			},
		} as never);

		expect(await handler?.({ toolName: "bash", input: { command: "git push" } })).toEqual({
			block: true,
			reason: "Approval actor is not allowed to approve this tool call.",
		});
	});

	it("audits approval requests and resolutions with reduced Pi annotations", async () => {
		type ToolCall = { id: string; toolName: string; input: unknown };
		type ToolHandler = (toolCall: ToolCall) => unknown | Promise<unknown>;
		let handler: ToolHandler | undefined;
		const entries: Array<{ type: string; data: Record<string, unknown> }> = [];
		const requested: unknown[] = [];
		const resolved: unknown[] = [];
		const extension = createApprovalExtension({
			policies: {
				bash: approval.command(),
			},
			context: () => ({
				turnId: "turn-1",
				triggerRecord: 4,
				inboundMessageId: "m1",
				adapter: "local",
				adapterId: "local",
				conversation: "room",
				actor: { id: "u1", name: "Ronan" },
			}),
			audit: {
				async requested(input) {
					requested.push(input);
					return { type: "approval_requested", record: 10, requestedAt: "now", ...input };
				},
				async resolved(input) {
					resolved.push(input);
					return { type: "approval_resolved", record: 11, resolvedAt: "later", ...input };
				},
			},
			async request() {
				return { approved: true, resolvedById: "admin", resolvedBy: "Admin", messageIds: ["remote-1"] };
			},
		});

		extension({
			on(event: string, next: ToolHandler) {
				if (event === "tool_call") handler = next;
			},
			appendEntry(type: string, data: Record<string, unknown>) {
				entries.push({ type, data });
			},
		} as never);

		await expect(
			handler?.({ id: "call-1", toolName: "bash", input: { command: "git push" } }),
		).resolves.toBeUndefined();
		expect(requested).toMatchObject([
			{
				approvalId: expect.any(String),
				turnId: "turn-1",
				triggerRecord: 4,
				toolCallId: "call-1",
				toolName: "bash",
				displayedAction: "git push",
			},
		]);
		expect(resolved).toMatchObject([
			{
				approvalId: expect.any(String),
				decision: "approved",
				source: "adapter_click",
				remoteMessageIds: ["remote-1"],
			},
		]);
		expect(entries).toEqual([
			{
				type: "heypi.turn",
				data: expect.objectContaining({
					turnId: "turn-1",
					inboundMessageId: "m1",
					triggerRecord: 4,
				}),
			},
			{
				type: "heypi.approval.requested",
				data: expect.objectContaining({
					authoritative: false,
					turnId: "turn-1",
					toolCallId: "call-1",
					heypiRecord: 10,
				}),
			},
			{
				type: "heypi.approval.resolved",
				data: expect.objectContaining({
					authoritative: false,
					decision: "approved",
					heypiRecord: 11,
				}),
			},
		]);
		expect(entries[1]?.data).not.toHaveProperty("input");
	});

	it("blocks approved tool calls when the canonical resolution write fails", async () => {
		type ToolCall = { toolName: string; input: unknown };
		type ToolHandler = (toolCall: ToolCall) => unknown | Promise<unknown>;
		let handler: ToolHandler | undefined;
		const extension = createApprovalExtension({
			policies: {
				bash: approval.command(),
			},
			context: () => ({
				turnId: "turn-1",
				triggerRecord: 4,
				adapter: "local",
				adapterId: "local",
				conversation: "room",
				actor: { id: "u1" },
			}),
			audit: {
				async requested(input): Promise<ApprovalRequestedRecord> {
					return { type: "approval_requested", record: 1, requestedAt: "now", ...input };
				},
				async resolved(): Promise<ApprovalResolvedRecord> {
					throw new Error("disk full");
				},
			},
			async request() {
				return { approved: true };
			},
		});

		extension({
			on(event: string, next: ToolHandler) {
				if (event === "tool_call") handler = next;
			},
			appendEntry() {},
		} as never);

		await expect(handler?.({ toolName: "bash", input: { command: "git push" } })).resolves.toEqual({
			block: true,
			reason: "Approval audit write failed.",
		});
	});
});

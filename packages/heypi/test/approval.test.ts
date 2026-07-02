import { describe, expect, it } from "vitest";
import { approval, classifyCommand, createApprovalExtension, renderApprovalMessage } from "../src/approval.js";
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
				"*Approval required*",
				"- Reason: Run bash command.",
				"- Command:\n```\ngit push\n```",
				"- Approval ID: abc",
				"- Requested by: @Ronan",
				"- Approved by: @Ronan",
			].join("\n"),
		);
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
					account: "workspace",
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
});

describe("createApprovalExtension", () => {
	it("uses default approval policy when no config is supplied", async () => {
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

		expect(await handler?.({ toolName: "bash", input: { command: "git push" } })).toEqual({
			block: true,
			reason: "Tool call rejected.",
		});
		expect(await handler?.({ toolName: "bash", input: { command: "git status" } })).toBeUndefined();
	});
});

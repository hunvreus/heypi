import { describe, expect, it } from "vitest";
import { renderApprovalMessage } from "../src/approval.js";

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

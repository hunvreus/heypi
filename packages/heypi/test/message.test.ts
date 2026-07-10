import { describe, expect, it } from "vitest";
import { formatOutgoingText } from "../src/message.js";

describe("formatOutgoingText", () => {
	it("appends outgoing attachment links to message text", () => {
		expect(
			formatOutgoingText("Here you go.", [
				{ name: "report.pdf", url: "https://example.com/report.pdf" },
				{ name: "trace.log", path: "/workspace/trace.log" },
			]),
		).toBe(
			[
				"Here you go.",
				"",
				"Attachments:",
				"- report.pdf: https://example.com/report.pdf",
				"- trace.log: /workspace/trace.log",
			].join("\n"),
		);
	});

	it("can render attachment-only messages", () => {
		expect(formatOutgoingText("", [{ id: "file-1", mime: "text/plain" }])).toBe(
			["Attachments:", "- text/plain: file-1"].join("\n"),
		);
	});

	it("ignores attachments without a usable target", () => {
		expect(formatOutgoingText("Done.", [{ name: "empty" }])).toBe("Done.");
	});
});

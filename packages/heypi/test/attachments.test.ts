import { readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { materializeAttachments } from "../src/attachments.js";

function makeDir(): string {
	return join(tmpdir(), `heypi-attachments-${Date.now()}-${Math.random().toString(36).slice(2)}`);
}

describe("attachment materialization", () => {
	it("downloads remote attachments into the workspace", async () => {
		const dir = makeDir();
		const attachments = await materializeAttachments(
			[
				{
					name: "notes.txt",
					url: "data:text/plain;base64,aGVsbG8=",
				},
			],
			{ dir, displayDir: "attachments/m1" },
		);

		expect(attachments).toEqual([
			{
				name: "notes.txt",
				url: "data:text/plain;base64,aGVsbG8=",
				path: "attachments/m1/notes.txt",
				localPath: join(dir, "notes.txt"),
				mime: "text/plain",
			},
		]);
		expect(await readFile(join(dir, "notes.txt"), "utf8")).toBe("hello");
	});

	it("keeps local attachments unchanged", async () => {
		const dir = makeDir();
		const attachments = await materializeAttachments(
			[
				{
					name: "report.txt",
					path: "report.txt",
					localPath: "/workspace/report.txt",
				},
			],
			{ dir },
		);

		expect(attachments).toEqual([
			{
				name: "report.txt",
				path: "report.txt",
				localPath: "/workspace/report.txt",
			},
		]);
		await expect(stat(join(dir, "report.txt"))).rejects.toThrow();
	});

	it("deduplicates unsafe filenames", async () => {
		const dir = makeDir();
		const attachments = await materializeAttachments(
			[
				{ name: "../notes.txt", url: "data:text/plain,one" },
				{ name: "../notes.txt", url: "data:text/plain,two" },
			],
			{ dir },
		);

		expect(attachments?.map((attachment) => attachment.path)).toEqual([
			"attachments/notes.txt",
			"attachments/notes-2.txt",
		]);
		expect(await readFile(join(dir, "notes.txt"), "utf8")).toBe("one");
		expect(await readFile(join(dir, "notes-2.txt"), "utf8")).toBe("two");
	});
});

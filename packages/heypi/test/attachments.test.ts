import { readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { materializeAttachments } from "../src/attachments.js";

afterEach(() => vi.unstubAllGlobals());

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

	it("stops reading a streaming response at the configured byte limit", async () => {
		const dir = makeDir();

		await expect(
			materializeAttachments([{ name: "large.txt", url: "data:text/plain,123456" }], {
				dir,
				maxBytes: 5,
			}),
		).rejects.toThrow("attachment is too large");
		await expect(stat(join(dir, "large.txt"))).rejects.toThrow();
	});

	it("restricts remote hosts and MIME types", async () => {
		const dir = makeDir();

		await expect(
			materializeAttachments([{ name: "notes.txt", url: "https://private.example/notes.txt" }], {
				dir,
				hosts: ["files.example"],
			}),
		).rejects.toThrow("attachment host is not allowed");

		await expect(
			materializeAttachments(
				[{ name: "script.js", mime: "application/javascript", url: "data:text/javascript,alert(1)" }],
				{ dir, mimeTypes: ["image/*", "text/plain"] },
			),
		).rejects.toThrow("attachment MIME type is not allowed");
	});

	it("retries safe downloads after transient failures", async () => {
		const dir = makeDir();
		const fetch = vi
			.fn()
			.mockResolvedValueOnce(new Response("unavailable", { status: 503 }))
			.mockResolvedValueOnce(new Response("ready", { headers: { "content-type": "text/plain" } }));
		vi.stubGlobal("fetch", fetch);

		const attachments = await materializeAttachments(
			[{ name: "notes.txt", url: "https://files.example/notes.txt" }],
			{
				dir,
				hosts: ["files.example"],
				retry: { attempts: 2, minDelayMs: 0 },
			},
		);

		expect(fetch).toHaveBeenCalledTimes(2);
		expect(await readFile(attachments?.[0]?.localPath ?? "", "utf8")).toBe("ready");
	});

	it("validates redirect destinations before following them", async () => {
		const dir = makeDir();
		const fetch = vi.fn().mockResolvedValue(
			new Response(null, {
				status: 302,
				headers: { location: "http://127.0.0.1/private" },
			}),
		);
		vi.stubGlobal("fetch", fetch);

		await expect(
			materializeAttachments([{ name: "notes.txt", url: "https://files.example/notes.txt" }], {
				dir,
				hosts: ["files.example"],
			}),
		).rejects.toThrow("attachment host is not allowed");
		expect(fetch).toHaveBeenCalledTimes(1);
	});

	it("cancels failed response bodies", async () => {
		const dir = makeDir();
		const cancel = vi.fn();
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue(
				new Response(
					new ReadableStream({
						cancel,
					}),
					{ status: 404 },
				),
			),
		);

		await expect(
			materializeAttachments([{ name: "missing.txt", url: "https://files.example/missing.txt" }], {
				dir,
				hosts: ["files.example"],
			}),
		).rejects.toThrow("attachment download failed: 404");
		expect(cancel).toHaveBeenCalledOnce();
	});

	it("removes files materialized before a later attachment fails", async () => {
		const dir = makeDir();
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue(new Response("first", { headers: { "content-type": "text/plain" } })),
		);

		await expect(
			materializeAttachments(
				[
					{ name: "first.txt", url: "https://files.example/first.txt" },
					{ name: "second.txt", url: "https://private.example/second.txt" },
				],
				{ dir, hosts: ["files.example"] },
			),
		).rejects.toThrow("attachment host is not allowed");

		await expect(stat(join(dir, "first.txt"))).rejects.toThrow();
	});
});

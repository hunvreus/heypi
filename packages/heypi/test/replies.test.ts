import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createReplyIndex } from "../src/replies.js";

describe("reply index", () => {
	it("recovers valid aliases before a truncated final record", async () => {
		const path = join(tmpdir(), `heypi-replies-${Date.now()}-${Math.random().toString(36).slice(2)}.jsonl`);
		await writeFile(path, '{"message":"m1","session":"s1"}\n{"message":', "utf8");
		const index = createReplyIndex(path);

		await index.load();
		await index.add("m2", "s2");
		const restored = createReplyIndex(path);
		await restored.load();

		expect(restored.resolve("m1")).toBe("s1");
		expect(restored.resolve("m2")).toBe("s2");
	});
});

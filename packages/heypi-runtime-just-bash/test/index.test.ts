import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { justBash } from "../src/index.js";

describe("just-bash runtime", () => {
	it("provides every Pi core tool over the mounted workspace", async () => {
		const workspace = await mkdtemp(join(tmpdir(), "heypi-just-bash-"));
		const runtime = justBash();
		const instance = await runtime.provider?.({ workspace });

		expect(instance?.tools.map((tool) => tool.name).sort()).toEqual([
			"bash",
			"edit",
			"find",
			"grep",
			"ls",
			"read",
			"write",
		]);
	});
});

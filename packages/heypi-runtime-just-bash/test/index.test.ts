import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
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

	it("mounts staged skills read-only for file and bash tools", async () => {
		const workspace = await mkdtemp(join(tmpdir(), "heypi-just-bash-workspace-"));
		const skills = await mkdtemp(join(tmpdir(), "heypi-just-bash-skills-"));
		await mkdir(join(skills, "review"));
		await writeFile(join(skills, "review", "SKILL.md"), "Review instructions\n");
		const instance = await justBash().provider?.({ workspace, skills });
		const read = instance?.tools.find((tool) => tool.name === "read");
		const bash = instance?.tools.find((tool) => tool.name === "bash");
		if (!read || !bash) throw new Error("Missing runtime tools");

		await expect(
			read.execute("read", { path: "/agent/skills/review/SKILL.md" }, undefined, undefined, {} as never),
		).resolves.toMatchObject({ content: [{ type: "text", text: "Review instructions\n" }] });
		await expect(
			bash.execute(
				"bash",
				{ command: "printf changed > /agent/skills/review/SKILL.md" },
				undefined,
				undefined,
				{} as never,
			),
		).rejects.toThrow("read-only filesystem");
	});
});

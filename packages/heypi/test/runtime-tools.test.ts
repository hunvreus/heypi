import { mkdir, readFile, realpath, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { host } from "../src/runtime.js";
import { createRuntimeTools } from "../src/runtime-tools.js";

async function makeWorkspace(): Promise<string> {
	const root = join(tmpdir(), `heypi-runtime-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	await mkdir(root, { recursive: true });
	return root;
}

function tool(tools: Awaited<ReturnType<typeof createRuntimeTools>>["tools"], name: string) {
	const match = tools.find((item) => item.name === name);
	if (!match) throw new Error(`Missing tool: ${name}`);
	return match;
}

describe("createRuntimeTools", () => {
	it("constrains host file tools to the runtime workspace", async () => {
		const workspace = await makeWorkspace();
		await mkdir(join(workspace, "src"), { recursive: true });
		await writeFile(join(workspace, "src", "index.ts"), "export const value = 1;\n");
		await writeFile(join(workspace, "README.md"), "hello\n");
		const runtime = await createRuntimeTools(host({ workspace }), workspace);

		const read = tool(runtime.tools, "read");
		const write = tool(runtime.tools, "write");
		const edit = tool(runtime.tools, "edit");
		const grep = tool(runtime.tools, "grep");
		const find = tool(runtime.tools, "find");
		const ls = tool(runtime.tools, "ls");

		await expect(
			read.execute("read", { path: "README.md" }, undefined, undefined, {} as never),
		).resolves.toMatchObject({
			content: [{ type: "text", text: "hello\n" }],
		});
		await expect(read.execute("read", { path: "../outside.txt" }, undefined, undefined, {} as never)).rejects.toThrow(
			"path escapes runtime workspace",
		);
		await expect(find.execute("find", { pattern: "*.ts" }, undefined, undefined, {} as never)).resolves.toMatchObject(
			{
				content: [{ type: "text", text: "src/index.ts" }],
			},
		);
		await expect(
			write.execute(
				"write",
				{ path: "src/new.ts", content: "export const next = 2;\n" },
				undefined,
				undefined,
				{} as never,
			),
		).resolves.toBeDefined();
		await expect(readFile(join(workspace, "src", "new.ts"), "utf8")).resolves.toBe("export const next = 2;\n");
		await expect(
			write.execute("write", { path: "root.txt", content: "root\n" }, undefined, undefined, {} as never),
		).resolves.toBeDefined();
		await expect(readFile(join(workspace, "root.txt"), "utf8")).resolves.toBe("root\n");
		await expect(
			write.execute("write", { path: "../outside.ts", content: "nope\n" }, undefined, undefined, {} as never),
		).rejects.toThrow("path escapes runtime workspace");
		await expect(
			edit.execute(
				"edit",
				{ path: "src/index.ts", edits: [{ oldText: "value = 1", newText: "value = 3" }] },
				undefined,
				undefined,
				{} as never,
			),
		).resolves.toBeDefined();
		await expect(readFile(join(workspace, "src", "index.ts"), "utf8")).resolves.toBe("export const value = 3;\n");
		await expect(
			edit.execute(
				"edit",
				{ path: "../outside.ts", edits: [{ oldText: "a", newText: "b" }] },
				undefined,
				undefined,
				{} as never,
			),
		).rejects.toThrow("path escapes runtime workspace");
		await expect(
			grep.execute("grep", { pattern: "value", path: "src/index.ts" }, undefined, undefined, {} as never),
		).resolves.toMatchObject({
			content: [{ type: "text", text: expect.stringContaining("value = 3") }],
		});
		await expect(
			grep.execute("grep", { pattern: "value", path: "../outside.ts" }, undefined, undefined, {} as never),
		).rejects.toThrow("path escapes runtime workspace");
		await expect(ls.execute("ls", { path: "src" }, undefined, undefined, {} as never)).resolves.toMatchObject({
			content: [{ type: "text", text: expect.stringContaining("index.ts") }],
		});
		await expect(ls.execute("ls", { path: "../outside" }, undefined, undefined, {} as never)).rejects.toThrow(
			"path escapes runtime workspace",
		);
	});

	it("starts host bash in the runtime workspace", async () => {
		const workspace = await makeWorkspace();
		const canonicalWorkspace = await realpath(workspace);
		const runtime = await createRuntimeTools(host({ workspace, env: { HEYPI_RUNTIME_TEST: "ok" } }), workspace);
		const bash = tool(runtime.tools, "bash");

		await expect(
			bash.execute(
				"bash",
				{ command: 'printf "%s\\n%s\\n" "$PWD" "$HEYPI_RUNTIME_TEST"' },
				undefined,
				undefined,
				{} as never,
			),
		).resolves.toMatchObject({
			content: [{ type: "text", text: expect.stringContaining(`${canonicalWorkspace}\nok`) }],
		});
	});

	it("exposes staged skills without allowing runtime changes into the canonical source", async () => {
		const workspace = await makeWorkspace();
		const agent = await makeWorkspace();
		const skills = join(agent, "skills");
		const outside = await makeWorkspace();
		await mkdir(skills, { recursive: true });
		await writeFile(join(skills, "github.md"), "GitHub instructions\n");
		await writeFile(join(outside, "secret.md"), "private\n");
		await symlink(join(outside, "secret.md"), join(skills, "escape.md"));
		const runtime = await createRuntimeTools(host({ workspace }), workspace, undefined, skills);

		await expect(
			tool(runtime.tools, "read").execute(
				"read",
				{ path: "/agent/skills/github.md" },
				undefined,
				undefined,
				{} as never,
			),
		).resolves.toMatchObject({ content: [{ type: "text", text: "GitHub instructions\n" }] });
		await expect(
			tool(runtime.tools, "read").execute(
				"read",
				{ path: "/agent/skills/escape.md" },
				undefined,
				undefined,
				{} as never,
			),
		).rejects.toThrow("path escapes runtime workspace");
		await expect(
			tool(runtime.tools, "write").execute(
				"write",
				{ path: "/agent/skills/new.md", content: "nope\n" },
				undefined,
				undefined,
				{} as never,
			),
		).rejects.toThrow("path is read-only");
		await tool(runtime.tools, "bash").execute(
			"bash",
			{ command: "printf changed > /agent/skills/github.md" },
			undefined,
			undefined,
			{} as never,
		);
		expect(await readFile(join(skills, "github.md"), "utf8")).toBe("GitHub instructions\n");
		await runtime.prepare?.();
		await expect(
			tool(runtime.tools, "read").execute(
				"read",
				{ path: "/agent/skills/github.md" },
				undefined,
				undefined,
				{} as never,
			),
		).resolves.toMatchObject({ content: [{ type: "text", text: "GitHub instructions\n" }] });
		await runtime.cleanup();
	});

	it("rewrites shell guest-path tokens without changing path prefixes", async () => {
		const workspace = await makeWorkspace();
		await writeFile(join(workspace, "value.txt"), "hello\n");
		const runtime = await createRuntimeTools(host({ workspace }), workspace);
		const bash = tool(runtime.tools, "bash");

		await expect(
			bash.execute(
				"bash",
				{
					command: `SUFFIX=/value.txt; cat "/workspace\${SUFFIX}"; cat \\/workspace/value.txt; printf "\\n%s\\n%s" "/tmp/workspace" "/workspace2"`,
				},
				undefined,
				undefined,
				{} as never,
			),
		).resolves.toMatchObject({
			content: [{ type: "text", text: "hello\nhello\n\n/tmp/workspace\n/workspace2" }],
		});
	});

	it("rejects host file-tool access through escaping symlinks", async () => {
		const workspace = await makeWorkspace();
		const outside = await makeWorkspace();
		await writeFile(join(outside, "secret.txt"), "private\n");
		await symlink(outside, join(workspace, "escape"));
		await symlink(join(outside, "secret.txt"), join(workspace, "linked.txt"));
		const runtime = await createRuntimeTools(host({ workspace }), workspace);

		await expect(
			tool(runtime.tools, "read").execute("read", { path: "escape/secret.txt" }, undefined, undefined, {} as never),
		).rejects.toThrow("path escapes runtime workspace");
		await expect(
			tool(runtime.tools, "find").execute("find", { pattern: "*.txt" }, undefined, undefined, {} as never),
		).rejects.toThrow("path escapes runtime workspace");
		await expect(
			tool(runtime.tools, "write").execute(
				"write",
				{ path: "linked.txt", content: "escaped\n" },
				undefined,
				undefined,
				{} as never,
			),
		).rejects.toThrow("path escapes runtime workspace");
		await expect(readFile(join(outside, "secret.txt"), "utf8")).resolves.toBe("private\n");
	});
});

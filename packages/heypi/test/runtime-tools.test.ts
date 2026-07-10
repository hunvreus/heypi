import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
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
});

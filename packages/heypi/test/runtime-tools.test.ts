import { mkdir, writeFile } from "node:fs/promises";
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
		const find = tool(runtime.tools, "find");

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
	});
});

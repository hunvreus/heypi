import assert from "node:assert/strict";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { localWorkspace, workspacePath } from "../src/workspace/workspace.js";

async function temp(): Promise<string> {
	return await mkdtemp(join(tmpdir(), "heypi-workspace-"));
}

test("workspacePath rejects absolute and escaping paths", () => {
	assert.equal(workspacePath("memory/scopes/a/MEMORY.md"), "memory/scopes/a/MEMORY.md");
	assert.equal(workspacePath("./memory//scopes/a"), "memory/scopes/a");
	assert.throws(() => workspacePath("/memory/scopes/a"), /relative/);
	assert.throws(() => workspacePath("../memory"), /escapes/);
	assert.throws(() => workspacePath("memory/../secret"), /escapes/);
	assert.throws(() => workspacePath("memory\\secret"), /forward slashes/);
	assert.throws(() => workspacePath("memory\0secret"), /null byte/);
});

test("localWorkspace reads, writes, lists, stats, and deletes files", async () => {
	const root = await temp();
	try {
		const store = localWorkspace(root);

		await store.write("memory/scopes/channel/MEMORY.md", Buffer.from("hello", "utf8"));
		assert.equal(Buffer.from((await store.read("memory/scopes/channel/MEMORY.md")) ?? []).toString("utf8"), "hello");

		const info = await store.stat("memory/scopes/channel/MEMORY.md");
		assert.equal(info?.type, "file");
		assert.equal(info?.size, 5);

		const entries = await store.list("memory");
		assert.deepEqual(
			entries.map((entry) => [entry.type, entry.path]),
			[
				["directory", "memory/scopes"],
				["directory", "memory/scopes/channel"],
				["file", "memory/scopes/channel/MEMORY.md"],
			],
		);

		await store.delete("memory/scopes/channel/MEMORY.md");
		assert.equal(await store.read("memory/scopes/channel/MEMORY.md"), undefined);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("localWorkspace rejects symlink escapes", async () => {
	const root = await temp();
	const outside = await temp();
	try {
		const store = localWorkspace(root);
		await writeFile(join(outside, "secret.txt"), "secret");
		await symlink(join(outside, "secret.txt"), join(root, "linked.txt"));

		await assert.rejects(() => store.read("linked.txt"), /escapes/);
		await assert.rejects(() => store.write("linked.txt", Buffer.from("overwrite")), /escapes/);
	} finally {
		await rm(root, { recursive: true, force: true });
		await rm(outside, { recursive: true, force: true });
	}
});

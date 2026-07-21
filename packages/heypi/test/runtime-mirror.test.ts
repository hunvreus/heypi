import {
	access,
	chmod,
	lstat,
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	readlink,
	rm,
	stat,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createRuntimeMirror } from "../src/runtime-mirror.js";
import type { RuntimeMirrorFileSystem } from "../src/runtime-provider.js";

function remoteFileSystem(root: string): RuntimeMirrorFileSystem {
	const resolve = (path: string) => join(root, path.replace(/^\//, ""));
	return {
		access: (path) => access(resolve(path)),
		chmod: (path, mode) => chmod(resolve(path), mode),
		mkdir: async (path) => {
			await mkdir(resolve(path), { recursive: true });
		},
		readFile: (path) => readFile(resolve(path)),
		readdir: (path) => readdir(resolve(path)),
		readlink: (path) => readlink(resolve(path)),
		lstat: (path) => lstat(resolve(path)),
		rm: (path) => rm(resolve(path), { recursive: true, force: true }),
		stat: (path) => stat(resolve(path)),
		symlink: (target, path) => symlink(target, resolve(path)),
		writeFile: async (path, content) => {
			await writeFile(resolve(path), content);
		},
	};
}

describe("runtime mirror", () => {
	it("propagates deletions, modes, and symlinks without removing unrelated host additions", async () => {
		const host = await mkdtemp(join(tmpdir(), "heypi-mirror-host-"));
		const remote = await mkdtemp(join(tmpdir(), "heypi-mirror-remote-"));
		const script = join(host, "script.sh");
		await writeFile(script, "#!/bin/sh\n", { mode: 0o755 });
		await symlink("script.sh", join(host, "script-link"));
		const fs = remoteFileSystem(remote);
		const mirror = createRuntimeMirror(fs, { workspace: host });

		await mirror.upload();
		expect((await stat(join(remote, "workspace", "script.sh"))).mode & 0o777).toBe(0o755);
		expect(await readlink(join(remote, "workspace", "script-link"))).toBe("script.sh");

		await rm(join(remote, "workspace", "script.sh"));
		await rm(join(remote, "workspace", "script-link"));
		await writeFile(join(remote, "workspace", "generated.sh"), "#!/bin/sh\n", { mode: 0o700 });
		await symlink("generated.sh", join(remote, "workspace", "generated-link"));
		await writeFile(join(host, "host-only.txt"), "keep\n");
		await mirror.download();

		await expect(access(script)).rejects.toThrow();
		await expect(access(join(host, "script-link"))).rejects.toThrow();
		expect(await readFile(join(host, "host-only.txt"), "utf8")).toBe("keep\n");
		expect((await stat(join(host, "generated.sh"))).mode & 0o777).toBe(0o700);
		expect(await readlink(join(host, "generated-link"))).toBe("generated.sh");
	});

	it("refreshes a reused remote from current host state", async () => {
		const host = await mkdtemp(join(tmpdir(), "heypi-mirror-refresh-host-"));
		const remote = await mkdtemp(join(tmpdir(), "heypi-mirror-refresh-remote-"));
		await writeFile(join(host, "changed.txt"), "old\n");
		await writeFile(join(host, "deleted.txt"), "delete\n");
		const mirror = createRuntimeMirror(remoteFileSystem(remote), { workspace: host });
		await mirror.upload();

		await writeFile(join(remote, "workspace", "changed.txt"), "stale\n");
		await writeFile(join(host, "changed.txt"), "new\n");
		await writeFile(join(host, "attachment.txt"), "attached\n");
		await rm(join(host, "deleted.txt"));
		await mirror.upload();

		expect(await readFile(join(remote, "workspace", "changed.txt"), "utf8")).toBe("new\n");
		expect(await readFile(join(remote, "workspace", "attachment.txt"), "utf8")).toBe("attached\n");
		await expect(access(join(remote, "workspace", "deleted.txt"))).rejects.toThrow();
	});

	it("replaces remote skills without accepting writes or syncing changes back", async () => {
		const host = await mkdtemp(join(tmpdir(), "heypi-mirror-skills-host-"));
		const skills = await mkdtemp(join(tmpdir(), "heypi-mirror-skills-source-"));
		const remote = await mkdtemp(join(tmpdir(), "heypi-mirror-skills-remote-"));
		await writeFile(join(skills, "review.md"), "Review instructions\n");
		const mirror = createRuntimeMirror(remoteFileSystem(remote), { workspace: host, skills });

		await mirror.upload();
		expect(await readFile(join(remote, "agent", "skills", "review.md"), "utf8")).toBe("Review instructions\n");
		await expect(mirror.fs.writeFile("/agent/skills/review.md", "changed\n")).rejects.toThrow("path is read-only");
		await writeFile(join(remote, "agent", "skills", "review.md"), "runtime change\n");
		await writeFile(join(remote, "agent", "skills", "extra.md"), "runtime addition\n");
		await mirror.download();
		await mirror.upload();

		expect(await readFile(join(skills, "review.md"), "utf8")).toBe("Review instructions\n");
		expect(await readFile(join(remote, "agent", "skills", "review.md"), "utf8")).toBe("Review instructions\n");
		await expect(access(join(remote, "agent", "skills", "extra.md"))).rejects.toThrow();
	});

	it("propagates deletion of files created through mirrored file tools", async () => {
		const host = await mkdtemp(join(tmpdir(), "heypi-mirror-write-host-"));
		const remote = await mkdtemp(join(tmpdir(), "heypi-mirror-write-remote-"));
		const mirror = createRuntimeMirror(remoteFileSystem(remote), { workspace: host });
		await mirror.upload();

		await mirror.fs.writeFile("/workspace/generated.txt", "generated\n");
		await rm(join(remote, "workspace", "generated.txt"));
		await mirror.download();

		await expect(access(join(host, "generated.txt"))).rejects.toThrow();
	});

	it("rejects escaping remote symlinks and translates internal absolute targets", async () => {
		const host = await mkdtemp(join(tmpdir(), "heypi-mirror-links-host-"));
		const remote = await mkdtemp(join(tmpdir(), "heypi-mirror-links-remote-"));
		const fs = remoteFileSystem(remote);
		const mirror = createRuntimeMirror(fs, { workspace: host });
		await mirror.upload();
		await writeFile(join(remote, "workspace", "target.txt"), "target\n");
		await symlink("/workspace/target.txt", join(remote, "workspace", "internal-link"));
		await mirror.download();
		expect(await readlink(join(host, "internal-link"))).toBe("target.txt");

		await symlink("/etc/passwd", join(remote, "workspace", "escaping-link"));
		await expect(mirror.download()).rejects.toThrow("symlink escapes runtime root");
		await expect(access(join(host, "escaping-link"))).rejects.toThrow();
	});

	it("rejects host symlinks outside the mirrored root", async () => {
		const host = await mkdtemp(join(tmpdir(), "heypi-mirror-host-link-host-"));
		const remote = await mkdtemp(join(tmpdir(), "heypi-mirror-host-link-remote-"));
		const outside = await mkdtemp(join(tmpdir(), "heypi-mirror-host-link-outside-"));
		await writeFile(join(outside, "secret.txt"), "secret\n");
		await symlink(join(outside, "secret.txt"), join(host, "escaping-link"));
		const mirror = createRuntimeMirror(remoteFileSystem(remote), { workspace: host });

		await expect(mirror.upload()).rejects.toThrow("symlink escapes runtime root");
		await expect(access(join(remote, "workspace", "escaping-link"))).rejects.toThrow();
	});

	it("preserves unresolved symlinks across mirror cycles", async () => {
		const host = await mkdtemp(join(tmpdir(), "heypi-mirror-links-host-"));
		const remote = await mkdtemp(join(tmpdir(), "heypi-mirror-links-remote-"));
		const mirror = createRuntimeMirror(remoteFileSystem(remote), { workspace: host });
		await mirror.upload();
		await symlink("missing.txt", join(remote, "workspace", "dangling"));
		await symlink("second", join(remote, "workspace", "first"));
		await symlink("first", join(remote, "workspace", "second"));

		await mirror.download();
		expect(await readlink(join(host, "dangling"))).toBe("missing.txt");
		await mirror.upload();
		expect(await readlink(join(remote, "workspace", "dangling"))).toBe("missing.txt");
		expect(await readlink(join(remote, "workspace", "first"))).toBe("second");
		expect(await readlink(join(remote, "workspace", "second"))).toBe("first");
	});

	it("rejects special files without trying to read them", async () => {
		const host = await mkdtemp(join(tmpdir(), "heypi-mirror-special-host-"));
		const remote = await mkdtemp(join(tmpdir(), "heypi-mirror-special-remote-"));
		const fs = remoteFileSystem(remote);
		const mirror = createRuntimeMirror(fs, { workspace: host });
		await mirror.upload();
		let read = false;
		const readdirRemote = fs.readdir;
		const lstatRemote = fs.lstat;
		const readRemote = fs.readFile;
		fs.readdir = (path) => (path === "/workspace" ? Promise.resolve(["pipe"]) : readdirRemote(path));
		fs.lstat = (path) =>
			path === "/workspace/pipe"
				? Promise.resolve({
						isDirectory: () => false,
						isFile: () => false,
						isSymbolicLink: () => false,
					})
				: lstatRemote(path);
		fs.readFile = (path) => {
			if (path === "/workspace/pipe") read = true;
			return readRemote(path);
		};

		await expect(mirror.download()).rejects.toThrow("unsupported runtime entry");
		expect(read).toBe(false);
	});
});

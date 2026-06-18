import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";

const CLI = resolve("dist/index.js");
const ROOT = resolve("../..");

function run(args: string[], cwd = process.cwd()): string {
	return execFileSync(process.execPath, [CLI, ...args], {
		cwd,
		encoding: "utf8",
		env: { ...process.env, NO_COLOR: "1" },
	});
}

test("creates a default Slack app non-interactively", async () => {
	const root = await mkdtemp(join(tmpdir(), "create-heypi-"));
	try {
		const app = join(root, "team-agent");
		const out = run([app, "--yes", "--no-install"]);
		assert.match(out, /Created /);
		assert.match(out, /For local agent messages/);
		assert.match(out, /Provider adapter/);
		assert.match(read(app, "package.json"), /"@hunvreus\/heypi"/);
		assert.match(read(app, "package.json"), /"zod"/);
		assert.match(read(app, "package.json"), /"dev": "heypi dev"/);
		assert.match(read(app, "package.json"), /"start": "heypi start"/);
		assert.match(read(app, "index.ts"), /slack\(\{\s*mode: "socket",\s*\}\)/);
		assert.match(read(app, "index.ts"), /const isDev = process\.env\.HEYPI_DEV === "1"/);
		assert.match(read(app, "index.ts"), /const adapters = isDev \? \[local\(\)\] : \[/);
		assert.match(read(app, "index.ts"), /local\(\)/);
		assert.match(read(app, "index.ts"), /export default app/);
		assert.match(read(app, "index.ts"), /pathToFileURL/);
		assert.match(read(app, "index.ts"), /mode: "socket"/);
		assert.match(
			read(app, "index.ts"),
			/http: \{ port: Number\(process\.env\.HEYPI_HTTP_PORT \?\? \(process\.env\.HEYPI_DEV \? 3000 : 0\)\) \}/,
		);
		assert.match(read(app, "index.ts"), /name: "just-bash"/);
		assert.match(read(app, "index.ts"), /openai\/gpt-5\.4-mini/);
		assert.match(read(app, ".env"), /OPENAI_API_KEY=/);
		assert.match(read(app, ".env.example"), /SLACK_BOT_TOKEN=/);
		assert.match(read(app, ".env.example"), /SLACK_APP_TOKEN=/);
		assert.match(read(app, ".env.example"), /HEYPI_HTTP_PORT=0/);
		assert.doesNotMatch(read(app, ".env.example"), /SLACK_SIGNING_SECRET=/);
		assert.match(read(app, "agent/AGENTS.md"), /concise team assistant/);
		assert.match(read(app, "agent/SOUL.md"), /Answer directly/);
		assert.match(read(app, "agent/skills/README.md"), /# Skills/);
		assert.match(read(app, "agent/tools/README.md"), /# Tools/);
		assert.match(read(app, "agent/evals/README.md"), /# Evals/);
		assert.match(read(app, "README.md"), /Fill in the model provider value/);
		assert.match(read(app, "README.md"), /Use it to send a test message/);
		assert.match(read(app, "README.md"), /run start/);
		assert.match(read(app, "setup/slack.manifest.json"), /socket_mode_enabled/);
		assert.match(read(app, "setup/slack.manifest.json"), /channels:read/);
		assert.doesNotMatch(read(app, "setup/slack.manifest.json"), /groups:history/);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("creates an HTTP-mode Slack app", async () => {
	const root = await mkdtemp(join(tmpdir(), "create-heypi-slack-http-"));
	try {
		const app = join(root, "http-agent");
		run([app, "--yes", "--adapter", "slack", "--slack-mode", "http", "--no-install"]);
		assert.match(read(app, "index.ts"), /mode: "http"/);
		assert.doesNotMatch(read(app, "index.ts"), /SLACK_SIGNING_SECRET/);
		assert.match(read(app, "index.ts"), /http: \{ port: Number\(process\.env\.PORT \?\? 3000\) \}/);
		assert.match(read(app, ".env.example"), /SLACK_BOT_TOKEN=/);
		assert.match(read(app, ".env.example"), /SLACK_SIGNING_SECRET=/);
		assert.match(read(app, ".env.example"), /PORT=3000/);
		assert.doesNotMatch(read(app, ".env.example"), /SLACK_APP_TOKEN=/);
		assert.match(read(app, "setup/slack.manifest.json"), /"socket_mode_enabled": false/);
		assert.match(
			read(app, "setup/slack.manifest.json"),
			/"request_url": "https:\/\/example\.com\/slack\/slack\/events"/,
		);
		assert.match(read(app, "setup/slack.manifest.json"), /channels:read/);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("creates adapter and runtime specific files", async () => {
	const root = await mkdtemp(join(tmpdir(), "create-heypi-runtime-"));
	try {
		const app = join(root, "discord-agent");
		run([
			app,
			"--yes",
			"--adapter",
			"discord",
			"--runtime",
			"docker",
			"--model",
			"openai/custom",
			"--samples",
			"--no-install",
		]);
		assert.match(read(app, "package.json"), /"@hunvreus\/heypi-runtime-docker"/);
		assert.match(read(app, "index.ts"), /discord\(\)/);
		assert.match(read(app, "index.ts"), /dockerRuntime\(\)/);
		assert.match(read(app, "index.ts"), /openai\/custom/);
		assert.match(read(app, ".env.example"), /DISCORD_BOT_TOKEN=/);
		assert.match(read(app, "agent/skills/example/SKILL.md"), /name: example/);
		assert.match(read(app, "agent/tools/now.ts"), /defineTool/);
		assert.match(read(app, "agent/tools/now.ts"), /from "zod"/);
		assert.match(read(app, "agent/tools/now.ts"), /z\.object/);
		assert.match(read(app, "agent/evals/smoke.ts"), /defineEval/);
		await linkLocalDeps(app, ["@hunvreus/heypi", "@hunvreus/heypi-runtime-docker"]);
		runTsc(app);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("uses the next default directory when heypi-app already exists", async () => {
	const root = await mkdtemp(join(tmpdir(), "create-heypi-default-dir-"));
	try {
		await mkdir(join(root, "heypi-app"));
		await writeFile(join(root, "heypi-app", "existing"), "already here", "utf8");
		run(["--yes", "--no-install"], root);
		assert.match(read(join(root, "heypi-app-1"), "index.ts"), /createHeypi/);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("refuses non-empty directories without force", async () => {
	const root = await mkdtemp(join(tmpdir(), "create-heypi-non-empty-"));
	try {
		const app = join(root, "app");
		await mkdir(app);
		await writeFile(join(app, "existing"), "already here", "utf8");
		await writeFile(join(app, ".env"), "DO_NOT_OVERWRITE=1\n", "utf8");
		assert.throws(() => run([app, "--yes", "--no-install"]), /target directory is not empty/);
		run([app, "--yes", "--force", "--no-install"]);
		assert.match(read(app, "index.ts"), /createHeypi/);
		assert.equal(read(app, ".env"), "DO_NOT_OVERWRITE=1\n");
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("adds provider env placeholders for non-OpenAI model choices", async () => {
	const root = await mkdtemp(join(tmpdir(), "create-heypi-xai-"));
	try {
		const app = join(root, "xai-agent");
		run([app, "--yes", "--model", "xai/grok-4.3", "--adapter", "webhook", "--no-install"]);
		assert.match(read(app, "index.ts"), /xai\/grok-4\.3/);
		assert.match(read(app, ".env.example"), /XAI_API_KEY=/);
		assert.match(read(app, ".env"), /WEBHOOK_SECRET=[a-f0-9]{48}/);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

async function linkLocalDeps(app: string, packages: string[]): Promise<void> {
	await mkdir(join(app, "node_modules", "@hunvreus"), { recursive: true });
	await mkdir(join(app, "node_modules", "@types"), { recursive: true });
	for (const name of packages) {
		const short = name.replace("@hunvreus/", "");
		await symlink(resolve(ROOT, "packages", short), join(app, "node_modules", "@hunvreus", short));
	}
	await symlink(resolve(ROOT, "node_modules", "@types", "node"), join(app, "node_modules", "@types", "node"));
	await symlink(resolve(ROOT, "packages", "heypi", "node_modules", "zod"), join(app, "node_modules", "zod"));
}

function read(root: string, path: string): string {
	return readFileSync(join(root, path), "utf8");
}

function runTsc(cwd: string): void {
	const result = spawnSync(resolve(ROOT, "node_modules/.bin/tsc"), ["--noEmit"], {
		cwd,
		encoding: "utf8",
	});
	assert.equal(result.status, 0, [result.stdout, result.stderr].filter(Boolean).join("\n"));
}

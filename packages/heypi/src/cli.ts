#!/usr/bin/env node

import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { listTemplates, scaffold } from "./scaffold.js";

const templatesDir = resolve(dirname(fileURLToPath(import.meta.url)), "templates");

function usage(): string {
	return `Usage:
  heypi create <template> [directory] [--no-install]
  heypi templates

Examples:
  heypi create codex-tag
  heypi create codex-tag my-agent --no-install`;
}

function packageManager(): "npm" | "pnpm" | "yarn" | "bun" {
	const name = process.env.npm_config_user_agent?.split("/")[0];
	if (name === "pnpm" || name === "yarn" || name === "bun") return name;
	return "npm";
}

async function install(directory: string, manager: ReturnType<typeof packageManager>): Promise<void> {
	const args = manager === "yarn" ? [] : ["install"];
	await new Promise<void>((resolvePromise, reject) => {
		const child = spawn(manager, args, { cwd: directory, stdio: "inherit" });
		child.once("error", reject);
		child.once("exit", (code, signal) => {
			if (code === 0) resolvePromise();
			else
				reject(
					new Error(`${manager} install failed${signal ? ` with signal ${signal}` : ` with exit code ${code}`}`),
				);
		});
	});
}

async function main(): Promise<void> {
	const raw = process.argv.slice(2);
	if (raw.length === 0 || raw.includes("--help") || raw.includes("-h")) {
		process.stdout.write(`${usage()}\n`);
		return;
	}

	if (raw[0] === "templates") {
		for (const template of await listTemplates(templatesDir)) process.stdout.write(`${template}\n`);
		return;
	}

	if (raw[0] !== "create") throw new Error(`Unknown command "${raw[0]}".\n\n${usage()}`);
	const noInstall = raw.includes("--no-install");
	const args = raw.slice(1).filter((value) => value !== "--no-install");
	if (args.length < 1 || args.length > 2) throw new Error(usage());

	const template = args[0];
	if (!template) throw new Error(usage());
	const destination = await scaffold({
		templatesDir,
		template,
		destination: args[1] ?? template,
	});
	process.stdout.write(`Created ${template} in ${destination}\n`);

	if (!noInstall) {
		const manager = packageManager();
		process.stdout.write(`Installing dependencies with ${manager}...\n`);
		await install(destination, manager);
	}

	process.stdout.write(`\nNext:\n  cd ${destination}\n  cp .env.example .env\n  ${packageManager()} run dev\n`);
}

main().catch((error: unknown) => {
	process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
	process.exitCode = 1;
});

#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { confirm, intro, isCancel, multiselect, note, outro, select, text } from "@clack/prompts";
import pc from "picocolors";
import { customModel, defaultModel, type ModelChoice, modelChoices } from "./models.js";

type Adapter = "slack" | "discord" | "telegram" | "webhook";
type Runtime = "just-bash" | "guarded-bash" | "docker" | "gondolin";
type PackageManager = "npm" | "pnpm" | "yarn" | "bun";
type SlackMode = "socket" | "http";

type Flags = {
	adapter?: Adapter;
	dir?: string;
	force: boolean;
	install?: boolean;
	model?: string;
	pm?: PackageManager;
	runtime?: Runtime;
	samples?: boolean;
	slackMode?: SlackMode;
	yes: boolean;
};

type Options = {
	adapter: Adapter;
	admin: boolean;
	dir: string;
	install: boolean;
	model: string;
	pm: PackageManager;
	runtime: Runtime;
	samples: boolean;
	slackMode?: SlackMode;
};

const adapters = ["slack", "discord", "telegram", "webhook"] as const;
const runtimes = ["just-bash", "guarded-bash", "docker", "gondolin"] as const;
const packageManagers = ["npm", "pnpm", "yarn", "bun"] as const;
const slackModes = ["socket", "http"] as const;

async function main(): Promise<void> {
	const flags = parseArgs(process.argv.slice(2));
	const options = await resolveOptions(flags);
	const root = resolve(options.dir);
	assertProjectName(options.dir);
	await assertWritableTarget(root, flags.force);
	await writeProject(root, options);
	if (options.install) install(root, options.pm);
	printNextSteps(root, options);
}

async function resolveOptions(flags: Flags): Promise<Options> {
	const defaultDir = flags.dir ?? (await nextAvailableDir("heypi-app"));
	if (flags.slackMode && flags.adapter && flags.adapter !== "slack") {
		throw new Error("--slack-mode only applies when --adapter is slack");
	}
	if (flags.yes) {
		return {
			adapter: flags.adapter ?? "slack",
			admin: true,
			dir: defaultDir,
			install: flags.install ?? true,
			model: flags.model ?? defaultModel,
			pm: flags.pm ?? inferPackageManager(),
			runtime: flags.runtime ?? "just-bash",
			samples: flags.samples ?? false,
			slackMode: flags.adapter === "slack" || !flags.adapter ? (flags.slackMode ?? "socket") : undefined,
		};
	}

	intro(pc.bold("create heypi"));
	note(
		[
			"Scaffold a TypeScript heypi chat agent.",
			"This creates files and .env placeholders. Slack, Discord, and Telegram still require external app or bot setup.",
		].join("\n"),
		"New app",
	);
	const dir = await promptText(
		"Project directory",
		defaultDir,
		"Folder to create. Must be empty unless --force is used.",
	);
	const adapter = flags.adapter ?? (await promptSelect("Adapter", adapterOptions(), "slack"));
	if (flags.slackMode && adapter !== "slack") throw new Error("--slack-mode only applies to Slack apps");
	const slackMode =
		adapter === "slack"
			? (flags.slackMode ?? (await promptSelect("Slack transport", slackModeOptions(), "socket")))
			: undefined;
	const runtime = flags.runtime ?? (await promptSelect("Runtime", runtimeOptions(), "just-bash"));
	const model = flags.model ?? (await promptModel());
	const admin = await promptConfirm(
		"Enable local admin UI",
		true,
		"Adds a local browser UI for jobs, approvals, and diagnostics.",
	);
	const sampleChoices = flags.samples
		? ["skills", "tools"]
		: await promptMultiSelect("Samples", [
				{ label: "Starter skill", value: "skills", hint: "agent/skills/example/SKILL.md" },
				{ label: "Starter tool module", value: "tools", hint: "tools/index.ts" },
			]);
	const pm = flags.pm ?? inferPackageManager();
	const installDeps =
		flags.install ??
		(await promptConfirm(
			`Install dependencies with ${pm}`,
			true,
			"Runs the package manager in the generated folder.",
		));
	return {
		adapter,
		admin,
		dir,
		install: installDeps,
		model,
		pm,
		runtime,
		samples: sampleChoices.length > 0,
		slackMode,
	};
}

async function nextAvailableDir(base: string): Promise<string> {
	if (await canUseDir(base)) return base;
	for (let index = 1; ; index++) {
		const candidate = `${base}-${index}`;
		if (await canUseDir(candidate)) return candidate;
	}
}

async function canUseDir(path: string): Promise<boolean> {
	if (!existsSync(path)) return true;
	try {
		return (await readdir(path)).length === 0;
	} catch {
		return false;
	}
}

async function writeProject(root: string, options: Options): Promise<void> {
	await mkdir(root, { recursive: true });
	await mkdir(join(root, "agent"), { recursive: true });
	await mkdir(join(root, "agent", "skills"), { recursive: true });
	await mkdir(join(root, "tools"), { recursive: true });
	await write(root, "package.json", packageJson(options));
	await write(root, "tsconfig.json", tsconfigJson());
	await write(root, "index.ts", indexTs(options));
	await write(root, ".env.example", envExample(options));
	await writeIfMissing(root, ".env", envFile(options));
	await write(root, ".gitignore", gitignore());
	await write(root, "README.md", readme(options));
	await write(root, "agent/AGENTS.md", agentPrompt());
	await write(root, "agent/SOUL.md", soul());
	await write(root, "agent/skills/README.md", skillsReadme());
	await write(root, "tools/README.md", toolsReadme());
	if (options.adapter === "slack") {
		await write(root, "setup/slack.manifest.json", slackManifest(options.slackMode ?? "socket"));
	}
	if (options.samples) {
		await mkdir(join(root, "agent", "skills", "example"), { recursive: true });
		await write(root, "agent/skills/example/SKILL.md", sampleSkill());
		await write(root, "tools/index.ts", sampleTool());
	}
}

async function assertWritableTarget(root: string, force: boolean): Promise<void> {
	if (!existsSync(root)) return;
	const entries = await readdir(root);
	if (entries.length === 0 || force) return;
	throw new Error(
		`target directory is not empty: ${root}. Choose another directory or pass --force to write into it.`,
	);
}

function install(root: string, pm: PackageManager): void {
	const command = pm;
	const args = pm === "yarn" ? [] : ["install"];
	execFileSync(command, args, { cwd: root, stdio: "inherit" });
}

function packageJson(options: Options): string {
	const deps: Record<string, string> = {
		"@hunvreus/heypi": "^0.1.4",
	};
	if (options.runtime === "docker") deps["@hunvreus/heypi-runtime-docker"] = "^0.1.4";
	if (options.runtime === "gondolin") deps["@hunvreus/heypi-runtime-gondolin"] = "^0.1.4";
	return json({
		name: packageName(options.dir),
		private: true,
		type: "module",
		scripts: {
			dev: "tsx watch --conditions development index.ts",
			start: "tsx --conditions development index.ts",
			check: "tsc --noEmit",
		},
		dependencies: deps,
		devDependencies: {
			"@types/node": "^25.9.1",
			tsx: "^4.22.3",
			typescript: "^6.0.3",
		},
	});
}

function tsconfigJson(): string {
	return json({
		compilerOptions: {
			target: "ES2022",
			module: "NodeNext",
			moduleResolution: "NodeNext",
			strict: true,
			esModuleInterop: true,
			forceConsistentCasingInFileNames: true,
			noUnusedLocals: true,
			noUnusedParameters: true,
			skipLibCheck: true,
			noEmit: true,
		},
		include: ["index.ts", "tools/**/*.ts"],
	});
}

function indexTs(options: Options): string {
	const imports = ["agentFrom", "createHeypi", "runHeypi", adapterImport(options.adapter), "workspace"];
	const runtimeImport =
		options.runtime === "docker"
			? 'import { dockerRuntime } from "@hunvreus/heypi-runtime-docker";\n'
			: options.runtime === "gondolin"
				? 'import { gondolinRuntime } from "@hunvreus/heypi-runtime-gondolin";\n'
				: "";
	return `import { ${imports.join(", ")} } from "@hunvreus/heypi";
${runtimeImport}
const app = createHeypi({
	state: { root: "./state" },
${httpConfig(options)}
	adapters: [
${adapterConfig(options)}
	],
	agent: agentFrom("./agent", { model: "${options.model}" }),
${options.admin ? "\tadmin: true,\n" : ""}\truntime: ${runtimeConfig(options.runtime)},
});

await runHeypi(app);
`;
}

function adapterImport(adapter: Adapter): string {
	if (adapter === "webhook") return "webhook";
	return adapter;
}

function httpConfig(options: Options): string {
	if (options.adapter === "slack" && options.slackMode === "http") {
		return "\thttp: { port: Number(process.env.PORT ?? 3000) },\n";
	}
	return "";
}

function adapterConfig(options: Options): string {
	if (options.adapter === "slack" && options.slackMode === "http") {
		return `\t\tslack({
\t\t\tmode: "http",
\t\t\tbotToken: process.env.SLACK_BOT_TOKEN!,
\t\t\tsigningSecret: process.env.SLACK_SIGNING_SECRET!,
\t\t}),`;
	}
	if (options.adapter === "slack") {
		return `\t\tslack({
\t\t\tmode: "socket",
\t\t\tbotToken: process.env.SLACK_BOT_TOKEN!,
\t\t\tappToken: process.env.SLACK_APP_TOKEN!,
\t\t}),`;
	}
	if (options.adapter === "discord") {
		return `\t\tdiscord({
\t\t\ttoken: process.env.DISCORD_BOT_TOKEN!,
\t\t}),`;
	}
	if (options.adapter === "telegram") {
		return `\t\ttelegram({
\t\t\ttoken: process.env.TELEGRAM_BOT_TOKEN!,
\t\t}),`;
	}
	return `\t\twebhook({
\t\t\tname: "default",
\t\t\tsecret: process.env.WEBHOOK_SECRET!,
\t\t}),`;
}

function runtimeConfig(runtime: Runtime): string {
	if (runtime === "docker") return '{ root: workspace("./workspace"), provider: dockerRuntime() }';
	if (runtime === "gondolin") return '{ root: workspace("./workspace"), provider: gondolinRuntime() }';
	if (runtime === "guarded-bash") return '{ name: "guarded-bash", root: workspace("./workspace") }';
	return '{ name: "just-bash", root: workspace("./workspace") }';
}

function envExample(options: Options): string {
	const rows = ["# Model provider credentials", ...modelEnvVars(options.model).map((name) => `${name}=`)];
	rows.push("", "# Adapter credentials");
	rows.push(...adapterEnvVars(options).map((name) => `${name}=`));
	return `${rows.join("\n")}\n`;
}

function envFile(options: Options): string {
	if (options.adapter !== "webhook") return envExample(options);
	return envExample(options).replace("WEBHOOK_SECRET=", `WEBHOOK_SECRET=${randomBytes(24).toString("hex")}`);
}

function gitignore(): string {
	return `.env
state/
workspace/
node_modules/
dist/
`;
}

function readme(options: Options): string {
	return `# ${packageName(options.dir)}

heypi app generated by \`create-heypi\`.

## Setup

1. Fill in \`.env\` values. \`.env.example\` documents the required variables.
2. Install dependencies if you skipped install:

\`\`\`bash
${options.pm} install
\`\`\`

3. Run the app:

\`\`\`bash
${options.pm} run dev
\`\`\`

## Adapter

Adapter: \`${options.adapter}\`

${adapterNotes(options)}

## Runtime

Runtime: \`${options.runtime}\`

${runtimeNotes(options.runtime)}

## Project Shape

- \`agent/AGENTS.md\`: behavioral instructions.
- \`agent/SOUL.md\`: voice and style.
- \`agent/skills/\`: reusable skill instructions loaded by \`agentFrom("./agent")\`.
- \`tools/\`: TypeScript helper modules you can import from \`index.ts\`.
`;
}

function adapterNotes(options: Options): string {
	if (options.adapter === "slack" && options.slackMode === "http") {
		return "Create a Slack app with the generated HTTP manifest, install it to your workspace, and set `SLACK_BOT_TOKEN` plus `SLACK_SIGNING_SECRET`.";
	}
	if (options.adapter === "slack") {
		return "Create a Slack app, enable Socket Mode, install it to your workspace, and set `SLACK_BOT_TOKEN` plus `SLACK_APP_TOKEN`.";
	}
	if (options.adapter === "discord") {
		return "Create a Discord application with a bot, invite it to your server, and set `DISCORD_BOT_TOKEN`.";
	}
	if (options.adapter === "telegram") {
		return "Create a Telegram bot with BotFather and set `TELEGRAM_BOT_TOKEN`.";
	}
	return "Configure your webhook sender with `WEBHOOK_SECRET` and route events to the heypi webhook endpoint.";
}

function runtimeNotes(runtime: Runtime): string {
	if (runtime === "docker") return "Runs tools inside Docker containers. Requires Docker to be installed and running.";
	if (runtime === "gondolin") return "Runs tools inside Gondolin VMs. Requires Gondolin credentials and access.";
	if (runtime === "guarded-bash") return "Runs shell commands on the host through heypi's guarded bash runtime.";
	return "Runs tools through heypi's built-in just-bash runtime rooted at `workspace/`.";
}

function agentPrompt(): string {
	return "You are a concise team assistant. Ask before taking irreversible actions.\n";
}

function soul(): string {
	return "Answer directly and accurately. Keep responses focused on the user's goal.\n";
}

function skillsReadme(): string {
	return `# Skills

Add skill folders here. Each skill should include a \`SKILL.md\` file with a short description and focused instructions.
`;
}

function toolsReadme(): string {
	return `# Tools

Add TypeScript helper modules here and import them from \`index.ts\` when you want to expose custom tools to the agent.
`;
}

const slackBotScopes = [
	"app_mentions:read",
	"channels:history",
	"channels:read",
	"chat:write",
	"chat:write.public",
	"files:read",
	"files:write",
	"im:history",
	"reactions:write",
	"usergroups:read",
] as const;

const slackBotEvents = ["app_mention", "message.channels", "message.im"] as const;

function slackManifest(mode: SlackMode): string {
	const settings: Record<string, unknown> = {
		event_subscriptions: {
			bot_events: slackBotEvents,
		},
		interactivity: {
			is_enabled: true,
		},
		org_deploy_enabled: false,
		socket_mode_enabled: mode === "socket",
		token_rotation_enabled: false,
	};
	if (mode === "http") {
		settings.event_subscriptions = {
			request_url: "https://example.com/slack/slack/events",
			bot_events: slackBotEvents,
		};
		settings.interactivity = {
			is_enabled: true,
			request_url: "https://example.com/slack/slack/events",
		};
	}
	return json({
		display_information: {
			name: "heypi",
			description: "heypi chat agent",
		},
		features: {
			bot_user: {
				display_name: "heypi",
				always_online: false,
			},
		},
		oauth_config: {
			scopes: {
				bot: slackBotScopes,
			},
		},
		settings,
	});
}

function sampleSkill(): string {
	return `---
name: example
description: Use when the user asks for a short project status summary.
---

Summarize the current state in three bullets: what is known, what is uncertain, and the next action.
`;
}

function sampleTool(): string {
	return `export function now(): string {
\treturn new Date().toISOString();
}
`;
}

function printNextSteps(root: string, options: Options): void {
	const run = options.pm === "npm" ? "npm run dev" : `${options.pm} run dev`;
	const install = options.pm === "yarn" ? "yarn" : `${options.pm} install`;
	const envVars = requiredEnvVars(options);
	const setup = adapterSetup(options);
	outro(pc.green("heypi app created"));
	process.stdout.write(`
${pc.green("Created project")}
  ${pc.cyan(root)}

${pc.bold("Next steps")}
  ${pc.bold(`cd ${root}`)}
  Fill in ${pc.bold(".env")}:
${envVars.map((name) => `    ${pc.bold(name)}`).join("\n")}
  ${pc.bold(options.install ? run : `${install} && ${run}`)}

${pc.bold(setup.title)}
  ${setup.body}
  ${pc.cyan(setup.url)}
`);
}

function requiredEnvVars(options: Options): string[] {
	return [...modelEnvVars(options.model), ...adapterEnvVars(options)];
}

function modelEnvVars(model: string): string[] {
	if (model.startsWith("anthropic/")) return ["ANTHROPIC_API_KEY"];
	if (model.startsWith("google/")) return ["GEMINI_API_KEY"];
	if (model.startsWith("xai/")) return ["XAI_API_KEY"];
	if (model.startsWith("openrouter/")) return ["OPENROUTER_API_KEY"];
	if (model.startsWith("vercel-ai-gateway/")) return ["AI_GATEWAY_API_KEY"];
	if (model.startsWith("cloudflare-ai-gateway/")) {
		return ["CLOUDFLARE_API_KEY", "CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_GATEWAY_ID"];
	}
	return ["OPENAI_API_KEY"];
}

function adapterEnvVars(options: Options): string[] {
	if (options.adapter === "slack" && options.slackMode === "http") {
		return ["SLACK_BOT_TOKEN", "SLACK_SIGNING_SECRET"];
	}
	if (options.adapter === "slack") return ["SLACK_BOT_TOKEN", "SLACK_APP_TOKEN"];
	if (options.adapter === "discord") return ["DISCORD_BOT_TOKEN", "DISCORD_CLIENT_ID"];
	if (options.adapter === "telegram") return ["TELEGRAM_BOT_TOKEN"];
	return ["WEBHOOK_SECRET"];
}

function adapterSetup(options: Options): { title: string; body: string; url: string } {
	if (options.adapter === "slack" && options.slackMode === "http") {
		return {
			title: "Slack setup",
			body: "Use setup/slack.manifest.json to create your HTTP-mode Slack app, then replace the example request URL with your public app URL.",
			url: "https://heypi.dev/docs/adapters/slack",
		};
	}
	if (options.adapter === "slack") {
		return {
			title: "Slack setup",
			body: "Use setup/slack.manifest.json to create and install your Socket Mode Slack app.",
			url: "https://heypi.dev/docs/adapters/slack",
		};
	}
	if (options.adapter === "discord") {
		return {
			title: "Discord setup",
			body: "Create a Discord app, add a bot, invite it to your server, then fill in .env.",
			url: "https://heypi.dev/docs/adapters/discord",
		};
	}
	if (options.adapter === "telegram") {
		return {
			title: "Telegram setup",
			body: "Create a bot with BotFather, then fill in .env with the bot token.",
			url: "https://heypi.dev/docs/adapters/telegram",
		};
	}
	return {
		title: "Webhook setup",
		body: "Configure your sender with WEBHOOK_SECRET and route events to the webhook endpoint.",
		url: "https://heypi.dev/docs/adapters/webhook",
	};
}

function parseArgs(args: string[]): Flags {
	const flags: Flags = { force: false, yes: false };
	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg === "--yes" || arg === "-y") flags.yes = true;
		else if (arg === "--force") flags.force = true;
		else if (arg === "--no-install") flags.install = false;
		else if (arg === "--install") flags.install = true;
		else if (arg === "--samples") flags.samples = true;
		else if (arg === "--no-samples") flags.samples = false;
		else if (arg === "--dir") flags.dir = requireValue(args, ++i, arg);
		else if (arg === "--adapter") flags.adapter = parseChoice(requireValue(args, ++i, arg), adapters, "adapter");
		else if (arg === "--runtime") flags.runtime = parseChoice(requireValue(args, ++i, arg), runtimes, "runtime");
		else if (arg === "--slack-mode")
			flags.slackMode = parseChoice(requireValue(args, ++i, arg), slackModes, "slack-mode");
		else if (arg === "--model") flags.model = requireValue(args, ++i, arg);
		else if (arg === "--pm") flags.pm = parseChoice(requireValue(args, ++i, arg), packageManagers, "pm");
		else if (arg === "--help" || arg === "-h") {
			help();
			process.exit(0);
		} else if (arg.startsWith("--")) {
			throw new Error(`Unknown option: ${arg}`);
		} else if (!flags.dir) {
			flags.dir = arg;
		} else {
			throw new Error(`Unexpected argument: ${arg}`);
		}
	}
	return flags;
}

function help(): void {
	process.stdout.write(`create-heypi

Usage:
  npm create heypi@latest [dir] [options]

Options:
  --adapter slack|discord|telegram|webhook
  --slack-mode socket|http
  --runtime just-bash|guarded-bash|docker|gondolin
  --model <model>
  --pm npm|pnpm|yarn|bun
  --yes, -y
  --install | --no-install
  --samples | --no-samples
  --force
`);
}

function requireValue(args: string[], index: number, flag: string): string {
	const value = args[index];
	if (!value || value.startsWith("--")) throw new Error(`Missing value for ${flag}`);
	return value;
}

function parseChoice<const T extends readonly string[]>(value: string, choices: T, name: string): T[number] {
	if ((choices as readonly string[]).includes(value)) return value as T[number];
	throw new Error(`Invalid --${name}: ${value}. Expected one of: ${choices.join(", ")}`);
}

function inferPackageManager(): PackageManager {
	const agent = process.env.npm_config_user_agent ?? "";
	if (agent.startsWith("pnpm")) return "pnpm";
	if (agent.startsWith("yarn")) return "yarn";
	if (agent.startsWith("bun")) return "bun";
	if (existsSync("pnpm-lock.yaml")) return "pnpm";
	if (existsSync("yarn.lock")) return "yarn";
	if (existsSync("bun.lock") || existsSync("bun.lockb")) return "bun";
	return "npm";
}

function packageName(dir: string): string {
	return basename(resolve(dir))
		.toLowerCase()
		.replace(/[^a-z0-9._-]+/g, "-")
		.replace(/^-+|-+$/g, "");
}

function assertProjectName(dir: string): void {
	if (packageName(dir)) return;
	throw new Error("project directory must produce a valid package name");
}

async function write(root: string, path: string, content: string): Promise<void> {
	const full = join(root, path);
	await mkdir(join(full, ".."), { recursive: true });
	await writeFile(full, content, "utf8");
}

async function writeIfMissing(root: string, path: string, content: string): Promise<void> {
	const full = join(root, path);
	if (existsSync(full)) return;
	await write(root, path, content);
}

function json(value: unknown): string {
	return `${JSON.stringify(value, null, "\t")}\n`;
}

function adapterOptions(): Array<{ label: string; value: Adapter; hint?: string }> {
	return [
		{ label: "Slack", value: "slack", hint: "Socket Mode starter" },
		{ label: "Discord", value: "discord" },
		{ label: "Telegram", value: "telegram" },
		{ label: "Webhook", value: "webhook" },
	];
}

function slackModeOptions(): Array<{ label: string; value: SlackMode; hint?: string }> {
	return [
		{ label: "Socket Mode", value: "socket", hint: "works locally without a public URL" },
		{ label: "HTTP webhook", value: "http", hint: "requires a public Slack request URL" },
	];
}

function runtimeOptions(): Array<{ label: string; value: Runtime; hint?: string }> {
	return [
		{ label: "just-bash", value: "just-bash", hint: "default local runtime rooted at workspace/" },
		{ label: "Docker", value: "docker", hint: "container runtime; requires Docker" },
		{ label: "Gondolin", value: "gondolin", hint: "VM runtime; requires Gondolin access" },
		{ label: "guarded-bash", value: "guarded-bash", hint: "advanced local host runtime" },
	];
}

async function promptText(message: string, initial: string, hint?: string): Promise<string> {
	const value = await text({
		message: hint ? `${message} (${hint})` : message,
		initialValue: initial,
		validate: (input) => (input?.trim() ? undefined : "Required"),
	});
	if (isCancel(value)) cancel();
	return value.trim();
}

async function promptConfirm(message: string, initial: boolean, hint?: string): Promise<boolean> {
	const value = await confirm({ message: hint ? `${message} (${hint})` : message, initialValue: initial });
	if (isCancel(value)) cancel();
	return value;
}

async function promptModel(): Promise<string> {
	const value = await promptSelect<ModelChoice>("Model", modelChoices, defaultModel);
	if (value !== customModel) return value;
	return promptText("Custom model", defaultModel, `Use provider/model format, for example ${defaultModel}.`);
}

async function promptSelect<T extends string>(
	message: string,
	options: ReadonlyArray<{ label: string; value: T; hint?: string }>,
	initial: T,
): Promise<T> {
	const value = await select<string>({ message, options: clackOptions(options), initialValue: initial });
	if (isCancel(value)) cancel();
	return value as T;
}

async function promptMultiSelect(
	message: string,
	options: Array<{ label: string; value: string; hint?: string }>,
): Promise<string[]> {
	const value = await multiselect<string>({ message, options: clackOptions(options), required: false });
	if (isCancel(value)) cancel();
	return value;
}

function clackOptions(options: ReadonlyArray<{ label: string; value: string; hint?: string }>): Array<{
	label: string;
	value: string;
	hint?: string;
}> {
	return options.map((option) =>
		option.hint
			? { label: option.label, value: option.value, hint: option.hint }
			: { label: option.label, value: option.value },
	);
}

function cancel(): never {
	process.stderr.write("Cancelled.\n");
	process.exit(1);
}

main().catch((error) => {
	process.stderr.write(`${pc.red("error")}: ${error instanceof Error ? error.message : String(error)}\n`);
	process.exitCode = 1;
});

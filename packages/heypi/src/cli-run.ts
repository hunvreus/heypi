import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { type CliEnvironment, loadCliEnvironment, redactCliText } from "./cli-env.js";
import {
	discordChannels,
	discordCheck,
	discordEnvExample,
	discordGuilds,
	discordInvite,
	probeDiscordGateway,
	slackChannels,
	slackCheck,
	slackEnvExample,
	slackManifest,
	slackUsers,
	telegramCheck,
	telegramEnvExample,
	telegramListen,
	telegramWebhookInfo,
} from "./cli-platforms.js";
import { booleanFlag, type CliContext, type CliFlags, type CliResult, flag } from "./cli-types.js";
import { listTemplates, scaffold } from "./scaffold.js";

const VALUE_FLAGS = new Set(["env-file", "query", "mode", "url", "guild", "timeout"]);
const BOOLEAN_FLAGS = new Set(["json", "help", "no-install", "private", "bots", "force"]);

export type CliIo = {
	stdout(value: string): void;
	stderr(value: string): void;
};

export type CliDependencies = {
	cwd?: string;
	environment?: CliEnvironment;
	fetch?: typeof fetch;
	discordGateway?: (token: string, fetcher: typeof fetch) => Promise<void>;
	templatesDir?: string;
	io?: CliIo;
};

type ParsedArguments = {
	flags: CliFlags;
	positionals: string[];
};

function usage(): string {
	return `Usage:
  heypi create <template> [directory] [--no-install]
  heypi templates
  heypi check [--json] [--env-file path]
  heypi slack check
  heypi slack channels [--query text] [--private]
  heypi slack users [--query text] [--bots]
  heypi slack manifest [--mode socket|http] [--url url]
  heypi slack env-example
  heypi discord check
  heypi discord guilds
  heypi discord channels --guild id [--query text]
  heypi discord invite
  heypi discord env-example
  heypi telegram check
  heypi telegram webhook-info
  heypi telegram listen [--timeout seconds] --force
  heypi telegram env-example

Global options:
  --env-file path  Load a specific environment file
  --json           Print machine-readable JSON
  --help           Show help`;
}

function parseArguments(raw: string[]): ParsedArguments {
	const flags: CliFlags = new Map();
	const positionals: string[] = [];
	for (let index = 0; index < raw.length; index += 1) {
		const value = raw[index];
		if (!value) continue;
		if (value === "-h") {
			flags.set("help", true);
			continue;
		}
		if (!value.startsWith("--")) {
			positionals.push(value);
			continue;
		}
		const equals = value.indexOf("=");
		const name = value.slice(2, equals === -1 ? undefined : equals);
		if (BOOLEAN_FLAGS.has(name)) {
			if (equals !== -1) throw new Error(`--${name} does not accept a value.`);
			flags.set(name, true);
			continue;
		}
		if (!VALUE_FLAGS.has(name)) throw new Error(`Unknown option --${name}.`);
		const next = equals === -1 ? raw[index + 1] : value.slice(equals + 1);
		if (!next || (equals === -1 && next.startsWith("--"))) throw new Error(`--${name} requires a value.`);
		flags.set(name, next);
		if (equals === -1) index += 1;
	}
	return { flags, positionals };
}

function packageManager(environment: CliEnvironment): "npm" | "pnpm" | "yarn" | "bun" {
	const name = environment.npm_config_user_agent?.split("/")[0];
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

function ensureArity(positionals: string[], minimum: number, maximum: number): void {
	if (positionals.length < minimum || positionals.length > maximum) throw new Error(usage());
}

async function aggregateChecks(context: CliContext): Promise<CliResult> {
	const configured: Array<{ platform: string; run: () => Promise<CliResult> }> = [];
	if (context.environment.SLACK_BOT_TOKEN || context.environment.SLACK_APP_TOKEN) {
		configured.push({ platform: "slack", run: () => slackCheck(context) });
	}
	if (context.environment.DISCORD_TOKEN) configured.push({ platform: "discord", run: () => discordCheck(context) });
	if (context.environment.TELEGRAM_BOT_TOKEN)
		configured.push({ platform: "telegram", run: () => telegramCheck(context) });
	if (configured.length === 0) {
		return {
			data: { ok: true, checks: [], message: "No adapter credentials configured." },
			lines: ["No adapter credentials configured."],
		};
	}

	const checks: Array<{ platform: string; ok: boolean; result?: unknown; error?: string }> = [];
	const lines: string[] = [];
	for (const item of configured) {
		try {
			const result = await item.run();
			checks.push({ platform: item.platform, ok: result.ok !== false, result: result.data });
			if (lines.length > 0) lines.push("");
			lines.push(...result.lines);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			checks.push({ platform: item.platform, ok: false, error: message });
			if (lines.length > 0) lines.push("");
			lines.push(`${item.platform}: failed`, `  fail setup: ${message}`);
		}
	}
	const ok = checks.every((check) => check.ok);
	return { ok, data: { ok, checks }, lines };
}

async function platformCommand(
	platform: string,
	command: string | undefined,
	flags: CliFlags,
	context: CliContext,
): Promise<CliResult> {
	if (platform === "slack") {
		if (command === "check") return slackCheck(context);
		if (command === "channels") return slackChannels(context, flags);
		if (command === "users") return slackUsers(context, flags);
		if (command === "manifest") return slackManifest(flags);
		if (command === "env-example") return slackEnvExample();
	}
	if (platform === "discord") {
		if (command === "check") return discordCheck(context);
		if (command === "guilds") return discordGuilds(context);
		if (command === "channels") return discordChannels(context, flags);
		if (command === "invite") return discordInvite(context);
		if (command === "env-example") return discordEnvExample();
	}
	if (platform === "telegram") {
		if (command === "check") return telegramCheck(context);
		if (command === "webhook-info") return telegramWebhookInfo(context);
		if (command === "listen") return telegramListen(context, flags);
		if (command === "env-example") return telegramEnvExample();
	}
	throw new Error(`Unknown command "${[platform, command].filter(Boolean).join(" ")}".\n\n${usage()}`);
}

async function execute(
	parsed: ParsedArguments,
	context: CliContext,
	templatesDir: string | undefined,
): Promise<CliResult> {
	const [command, subcommand, ...rest] = parsed.positionals;
	if (!command || booleanFlag(parsed.flags, "help")) return { data: { usage: usage() }, lines: [usage()] };
	if (command === "templates") {
		ensureArity(parsed.positionals, 1, 1);
		if (!templatesDir) throw new Error("Template directory is unavailable.");
		const templates = await listTemplates(templatesDir);
		return { data: { templates }, lines: templates };
	}
	if (command === "create") {
		ensureArity(parsed.positionals, 2, 3);
		if (!templatesDir) throw new Error("Template directory is unavailable.");
		const template = subcommand as string;
		const destination = await scaffold({
			templatesDir,
			template,
			destination: rest[0] ?? template,
		});
		const manager = packageManager(context.environment);
		const lines = [`Created ${template} in ${destination}`];
		if (!booleanFlag(parsed.flags, "no-install")) {
			lines.push(`Installing dependencies with ${manager}...`);
			await install(destination, manager);
		}
		lines.push("", "Next:", `  cd ${destination}`, "  cp .env.example .env", `  ${manager} run dev`);
		return { data: { template, destination }, lines };
	}
	if (command === "check") {
		ensureArity(parsed.positionals, 1, 1);
		return aggregateChecks(context);
	}
	if (command === "slack" || command === "discord" || command === "telegram") {
		ensureArity(parsed.positionals, 2, 2);
		return platformCommand(command, subcommand, parsed.flags, context);
	}
	throw new Error(`Unknown command "${command}".\n\n${usage()}`);
}

/** Runs one HeyPi CLI invocation and returns its intended process exit code. */
export async function runCli(raw: string[], dependencies: CliDependencies = {}): Promise<number> {
	const cwd = resolve(dependencies.cwd ?? process.cwd());
	const baseEnvironment = dependencies.environment ?? process.env;
	const io = dependencies.io ?? {
		stdout: (value: string) => process.stdout.write(value),
		stderr: (value: string) => process.stderr.write(value),
	};
	let environment = baseEnvironment;
	try {
		const parsed = parseArguments(raw);
		environment = await loadCliEnvironment(cwd, baseEnvironment, flag(parsed.flags, "env-file"));
		const context: CliContext = {
			environment,
			fetch: dependencies.fetch ?? globalThis.fetch,
			discordGateway: dependencies.discordGateway ?? probeDiscordGateway,
		};
		const result = await execute(parsed, context, dependencies.templatesDir);
		const output = booleanFlag(parsed.flags, "json") ? JSON.stringify(result.data, null, 2) : result.lines.join("\n");
		io.stdout(`${redactCliText(output, environment)}\n`);
		return result.ok === false ? 1 : 0;
	} catch (error) {
		const message = redactCliText(error instanceof Error ? error.message : String(error), environment);
		io.stderr(`${message}\n`);
		return 1;
	}
}

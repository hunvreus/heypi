#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { loadEnvFile } from "node:process";
import { pathToFileURL } from "node:url";
import { cac } from "cac";
import pc from "picocolors";
import {
	type AdminServerDescriptor,
	adminLoginUrl,
	createAdminLoginToken,
	processAlive,
	readAdminSecret,
	readAdminServerDescriptors,
} from "./admin/auth.js";
import type { HeypiApp } from "./app.js";
import { COMMANDS } from "./core/commands.js";
import { enqueueJobRuns } from "./core/scheduler.js";
import type { EvalConfig, EvalExpect } from "./eval.js";
import {
	discordCheck as checkDiscord,
	discordChannels,
	discordInviteUrl,
	discordObserve as observeDiscord,
} from "./io/discord-discovery.js";
import { slackChannels, slackUsers } from "./io/slack-discovery.js";
import { loadEvals } from "./load.js";
import { openDb } from "./store/db.js";
import { migrate, migrationStatus } from "./store/migrate.js";
import { ApprovalRepo } from "./store/repo-approval.js";
import { ApprovalBypassRepo } from "./store/repo-approval-bypass.js";
import { CallRepo } from "./store/repo-call.js";
import { JobRepo, JobRunRepo } from "./store/repo-job.js";
import { LockRepo } from "./store/repo-lock.js";
import { ThreadRepo } from "./store/repo-thread.js";
import { TurnRepo } from "./store/repo-turn.js";

const VERSION = packageVersion();

type Flags = Record<string, string | number | boolean>;
type SlackMode = "socket" | "http";

const slackModes = ["socket", "http"] as const;
const slackBotScopes = [
	"app_mentions:read",
	"channels:history",
	"channels:read",
	"chat:write",
	"chat:write.public",
	"commands",
	"files:read",
	"files:write",
	"im:history",
	"reactions:write",
	"usergroups:read",
	"users:read",
] as const;
const slackBotEvents = ["app_mention", "message.channels", "message.im"] as const;

async function main(): Promise<void> {
	const cli = buildCli();
	const parsed = cli.parse(process.argv, { run: false });
	if (process.argv.slice(2).length === 0) return line(helpText());
	if (cli.options.version && !cli.matchedCommandName) return cli.outputVersion();
	if (cli.options.help) return cli.outputHelp();
	if (!cli.matchedCommand) throw new Error(`Unknown command: ${parsed.args.join(" ")}`);
	await cli.runMatchedCommand();
}

function buildCli() {
	const cli = cac("heypi");
	cli.version(VERSION);
	cli.help();
	cli.command("help", "Show help").action(() => line(helpText()));
	cli.command("version", "Show version").action(() => line(VERSION));
	cli.command("init", "Create a new heypi app").action(init);
	cli.command("start [file]", "Start a heypi app")
		.option("--env <path>", "Load env file")
		.action((file: string | undefined, flags: Flags) => withEnv((input) => startApp(file, input))(flags));
	cli.command("dev [file]", "Start a heypi app in local dev mode")
		.option("--env <path>", "Load env file")
		.action((file: string | undefined, flags: Flags) => withEnv((input) => dev(file, input))(flags));
	cli.command("check", "Run local setup checks")
		.option("--env <path>", "Load env file")
		.option("--db <path>", "SQLite database path")
		.option("--runtime-root <path>", "Runtime workspace path")
		.action(withEnv(check));
	cli.command("status", "Inspect persisted app status")
		.option("--env <path>", "Load env file")
		.option("--db <path>", "SQLite database path")
		.option("--agent <id>", "Filter status for one agent")
		.option("--runtime-root <path>", "Runtime workspace path")
		.option("--json", "Print JSON")
		.action(withEnv(status));
	cli.command("db <action>", "Database commands: check, migrate")
		.option("--db <path>", "SQLite database path")
		.action((action: string, flags: Flags) =>
			withEnv((input) => {
				if (action === "check") return dbCheck(input);
				if (action === "migrate") return dbMigrate(input);
				throw new Error(`Unknown command: db ${action}`);
			})(flags),
		);
	cli.command("slack <action> [query]", "Slack commands: check, manifest, channels, users, env")
		.option("--env <path>", "Load env file")
		.option("--bot-token <token>", "Slack bot token")
		.option("--app-token <token>", "Slack app token")
		.option("--signing-secret <secret>", "Slack signing secret")
		.option("--mode <mode>", "Slack transport: socket or http")
		.option("--url <url>", "Slack events URL")
		.option("--command <command>", "Slack slash command")
		.option("--private", "Include private channels visible to the bot")
		.option("--bots", "Include bot users")
		.option("--query <text>", "Filter Slack channels or users by name or ID")
		.action((action: string, query: string | undefined, flags: Flags) =>
			withEnv((input) => {
				if (action === "check") return slackCheck(input);
				if (action === "manifest") return slackManifest(input);
				if (action === "channels") return slackChannelsList(input, query);
				if (action === "users") return slackUsersList(input, query);
				if (action === "env") return slackEnv();
				throw new Error(`Unknown command: slack ${action}`);
			})(flags),
		);
	cli.command("telegram <action>", "Telegram commands: check, observe, set-webhook, delete-webhook")
		.option("--env <path>", "Load env file")
		.option("--token <token>", "Telegram bot token")
		.option("--timeout <seconds>", "Timeout in seconds")
		.option("--url <url>", "Telegram webhook URL")
		.option("--secret-token <token>", "Telegram webhook secret token")
		.action((action: string, flags: Flags) =>
			withEnv((input) => {
				if (action === "check") return telegramCheck(input);
				if (action === "observe") return telegramObserve(input);
				if (action === "set-webhook") return telegramSetWebhook(input);
				if (action === "delete-webhook") return telegramDeleteWebhook(input);
				throw new Error(`Unknown command: telegram ${action}`);
			})(flags),
		);
	cli.command("discord <action> [query]", "Discord commands: check, observe, channels, invite, env")
		.option("--env <path>", "Load env file")
		.option("--token <token>", "Discord bot token")
		.option("--client-id <id>", "Discord application/client ID")
		.option("--timeout <seconds>", "Timeout in seconds")
		.option("--query <text>", "Filter Discord channels by guild, channel name, or ID")
		.action((action: string, query: string | undefined, flags: Flags) =>
			withEnv((input) => {
				if (action === "check") return discordCheck(input);
				if (action === "observe") return discordObserve(input);
				if (action === "channels") return discordChannelsList(input, query);
				if (action === "invite") return discordInvite(input);
				if (action === "env") return discordEnv();
				throw new Error(`Unknown command: discord ${action}`);
			})(flags),
		);
	cli.command("admin <action>", "Admin commands: link")
		.option("--env <path>", "Load env file")
		.option("--state <path>", "heypi state directory")
		.option("--pid <pid>", "Select one running admin server")
		.option("--url <url>", "Admin base URL")
		.option("--json", "Print JSON")
		.action((action: string, flags: Flags) =>
			withEnv((input) => {
				if (action === "link") return adminLink(input);
				throw new Error(`Unknown command: admin ${action}`);
			})(flags),
		);
	cli.command("jobs <action> [id]", "Job commands: list, show, run, pause, resume")
		.option("--db <path>", "SQLite database path")
		.option("--agent <id>", "Filter or mutate jobs for one agent")
		.option("--limit <count>", "Maximum jobs to list")
		.option("--json", "Print JSON")
		.action((action: string, id: string | undefined, flags: Flags) =>
			withEnv((input) => {
				if (action === "list") return jobsList(input);
				if (!id) throw new Error(`Missing job id for jobs ${action}`);
				if (action === "show") return jobsShow(input, id);
				if (action === "run") return jobsRun(input, id);
				if (action === "pause") return jobsState(input, id, "paused");
				if (action === "resume") return jobsState(input, id, "active");
				throw new Error(`Unknown command: jobs ${action}`);
			})(flags),
		);
	cli.command("eval <action> [name]", "Eval commands: list, show, check")
		.option("--agent <path>", "Agent folder")
		.option("--tag <tag>", "Filter by tag")
		.option("--json", "Print JSON")
		.action((action: string, name: string | undefined, flags: Flags) =>
			withEnv((input) => {
				if (action === "list") return evalsList(input);
				if (action === "check") return evalsCheck(input);
				if (!name) throw new Error(`Missing eval name for eval ${action}`);
				if (action === "show") return evalsShow(input, name);
				throw new Error(`Unknown command: eval ${action}`);
			})(flags),
		);
	cli.command("approvals <action> [id]", "Approval commands: list, show, bypasses")
		.option("--db <path>", "SQLite database path")
		.option("--agent <id>", "Filter approvals or bypasses for one agent")
		.option("--limit <count>", "Maximum approvals to list")
		.option("--json", "Print JSON")
		.action((action: string, id: string | undefined, flags: Flags) =>
			withEnv((input) => {
				if (action === "list") return approvalsList(input);
				if (action === "bypasses") return approvalBypassesList(input);
				if (!id) throw new Error(`Missing approval id for approvals ${action}`);
				if (action === "show") return approvalsShow(input, id);
				throw new Error(`Unknown command: approvals ${action}`);
			})(flags),
		);
	return cli;
}

function withEnv(fn: (flags: Flags) => void | Promise<void>): (flags: Flags) => Promise<void> {
	return async (flags) => {
		loadEnv(flags);
		await fn(flags);
	};
}

function loadEnv(flags: Flags): void {
	const raw = stringFlag(flags, "env") ?? ".env";
	const path = isAbsolute(raw) ? raw : resolve(invocationRoot(), raw);
	if (existsSync(path)) loadEnvFile(path);
}

async function startApp(file: string | undefined, _flags: Flags): Promise<void> {
	if (!process.env.HEYPI_CLI_CHILD) return await spawnWithTsx("start", file, {});
	const app = await loadApp(file);
	const { runHeypi } = await import("./app.js");
	await runHeypi(app);
}

async function dev(file: string | undefined, _flags: Flags): Promise<void> {
	if (!process.env.HEYPI_CLI_CHILD) return await spawnWithTsx("dev", file, { HEYPI_DEV: "1" });
	const app = await loadApp(file);
	const { runHeypi } = await import("./app.js");
	await runHeypi(app);
	line(`dev: http://127.0.0.1:${process.env.HEYPI_HTTP_PORT ?? process.env.PORT ?? "3000"}/admin`);
	line('dev: POST JSON to /dev/messages with { "text": "hello", "sync": true }');
}

async function spawnWithTsx(command: "start" | "dev", file: string | undefined, env: NodeJS.ProcessEnv): Promise<void> {
	const cli = process.argv[1];
	if (!cli) throw new Error("cannot resolve heypi CLI entrypoint");
	const args = ["--conditions", "development", cli, command];
	if (file) args.push(file);
	const child = spawn("tsx", args, {
		cwd: invocationRoot(),
		env: { ...process.env, ...env, HEYPI_CLI_CHILD: "1" },
		stdio: "inherit",
	});
	await new Promise<void>((resolve, reject) => {
		child.once("error", reject);
		child.once("exit", (code, signal) => {
			if (signal) {
				process.exitCode = 128;
				resolve();
				return;
			}
			process.exitCode = code ?? 0;
			resolve();
		});
	});
}

async function loadApp(file: string | undefined): Promise<HeypiApp> {
	const target = resolve(invocationRoot(), file ?? "index.ts");
	const mod = (await import(pathToFileURL(target).href)) as { default?: unknown; app?: unknown };
	const app = mod.default ?? mod.app;
	if (!isHeypiApp(app)) {
		throw new Error(`heypi ${target} must export a default app from createHeypi(...)`);
	}
	return app;
}

function isHeypiApp(input: unknown): input is HeypiApp {
	return (
		typeof input === "object" &&
		input !== null &&
		typeof (input as { start?: unknown }).start === "function" &&
		typeof (input as { stop?: unknown }).stop === "function"
	);
}

async function check(flags: Flags): Promise<void> {
	const rows: string[] = [];
	rows.push(ok(process.versions.node ? `node ${process.versions.node}` : "node missing"));
	rows.push(envCheck("OPENAI_API_KEY"));
	const db = stringFlag(flags, "db");
	if (db) rows.push(await checkDb(db));
	const root = stringFlag(flags, "runtime-root");
	if (root) rows.push(checkDir(root, "runtime root"));
	line(rows.join("\n"));
}

async function status(flags: Flags): Promise<void> {
	const dbPath = requiredFlag(flags, "db");
	const db = dbFor(dbPath);
	const migrations = await migrationStatus(db);
	const agent = stringFlag(flags, "agent") ?? "default";
	if (migrations.state !== "ok") {
		const body = {
			agent,
			database: {
				path: dbPath,
				migrations: migrations.state,
				applied: migrations.applied,
				pending: migrations.pending,
				message:
					migrations.state === "pending"
						? `Run heypi db migrate --db ${dbPath}`
						: `Migration changed after apply: ${migrations.changed}`,
			},
			status: "unavailable",
			checkedAt: Date.now(),
		};
		if (booleanFlag(flags, "json")) return line(JSON.stringify(body, null, 2));
		const details =
			migrations.state === "pending"
				? `${migrations.pending.length} pending; run heypi db migrate --db ${dbPath}`
				: `changed after apply: ${migrations.changed}`;
		return line(
			[warn(`database migrations ${details}`), warn("status unavailable until migrations are current")].join("\n"),
		);
	}
	const now = Date.now();
	const jobs = new JobRepo(db);
	const turns = new TurnRepo(db);
	const calls = new CallRepo(db);
	const approvals = new ApprovalRepo(db);
	const bypasses = new ApprovalBypassRepo(db);
	const locks = new LockRepo(db);
	const runtimeRoot = stringFlag(flags, "runtime-root");
	const [
		totalJobs,
		activeJobs,
		pausedJobs,
		dueJobs,
		runningTurns,
		runningCalls,
		pendingCalls,
		pendingApprovals,
		activeBypasses,
		appLock,
	] = await Promise.all([
		jobs.count({ agent }),
		jobs.count({ agent, state: "active" }),
		jobs.count({ agent, state: "paused" }),
		jobs.count({ agent, state: "active", dueAt: now }),
		turns.count({ agent, states: ["running"] }),
		calls.count({ agent, states: ["running"] }),
		calls.count({ agent, states: ["pending_approval"] }),
		approvals.countPending({ agent }),
		bypasses.countActive({ agent, now }),
		locks.get(`app:${agent}`),
	]);
	const body = {
		agent,
		database: { path: dbPath, migrations: "ok", applied: migrations.applied, pending: migrations.pending },
		runtimeRoot: runtimeRoot
			? { path: runtimeRoot, exists: existsSync(runtimeRoot) && statSync(runtimeRoot).isDirectory() }
			: null,
		lock: appLock
			? {
					key: appLock.key,
					owner: appLock.owner,
					expiresAt: appLock.expiresAt,
					active: appLock.expiresAt > now,
				}
			: null,
		turns: { running: runningTurns },
		calls: { running: runningCalls, pendingApproval: pendingCalls },
		approvals: { pending: pendingApprovals, bypasses: activeBypasses },
		jobs: {
			total: totalJobs,
			active: activeJobs,
			paused: pausedJobs,
			due: dueJobs,
		},
		checkedAt: now,
	};
	if (booleanFlag(flags, "json")) return line(JSON.stringify(body, null, 2));
	const rows = [
		ok(`database ok: ${dbPath}`),
		runtimeRoot
			? body.runtimeRoot?.exists
				? ok(`runtime root exists: ${runtimeRoot}`)
				: fail(`runtime root missing: ${runtimeRoot}`)
			: warn("runtime root not checked"),
		appLock
			? appLock.expiresAt > now
				? ok(`app lock active: ${appLock.owner} until ${fmtTime(appLock.expiresAt)}`)
				: warn(`app lock expired: ${appLock.owner} at ${fmtTime(appLock.expiresAt)}`)
			: warn(`app lock missing: app:${agent}`),
		`turns: ${runningTurns} running`,
		`calls: ${runningCalls} running, ${pendingCalls} pending approval`,
		`approvals: ${pendingApprovals} pending, ${activeBypasses} active bypasses`,
		`jobs: ${totalJobs} total, ${activeJobs} active, ${pausedJobs} paused, ${dueJobs} due`,
	];
	line(rows.join("\n"));
}

function init(): void {
	line("Create a new heypi app with:");
	line("");
	line("  npm create heypi@latest");
	line("");
	line("For non-interactive setup:");
	line("  npm create heypi@latest my-agent -- --yes");
}

async function dbCheck(flags: Flags): Promise<void> {
	line(await checkDb(requiredFlag(flags, "db")));
}

async function dbMigrate(flags: Flags): Promise<void> {
	const db = dbFor(requiredFlag(flags, "db"));
	await migrate(db);
	line(ok("database migrated"));
}

async function slackCheck(flags: Flags): Promise<void> {
	const token = secret(flags, "bot-token", "SLACK_BOT_TOKEN");
	const appToken = optionalSecret(flags, "app-token", "SLACK_APP_TOKEN");
	const signingSecret = optionalSecret(flags, "signing-secret", "SLACK_SIGNING_SECRET");
	const mode = optionalSlackMode(flags);
	const auth = await slackCall<{ ok: boolean; team?: string; user?: string; bot_id?: string }>(token, "auth.test", {});
	line(ok(`Slack auth ok: team=${auth.team ?? "?"} user=${auth.user ?? "?"} bot=${auth.bot_id ?? "?"}`));
	if (mode === "http" || mode === undefined) {
		line(
			signingSecret
				? ok("SLACK_SIGNING_SECRET present")
				: warn(
						mode === "http"
							? "SLACK_SIGNING_SECRET missing"
							: "SLACK_SIGNING_SECRET missing; required only for HTTP mode",
					),
		);
	}
	if (mode === "socket" || mode === undefined) {
		line(
			appToken
				? ok("SLACK_APP_TOKEN present for Socket Mode")
				: warn(
						mode === "socket"
							? "SLACK_APP_TOKEN missing"
							: "SLACK_APP_TOKEN missing; needed only for Socket Mode",
					),
		);
	}
}

function slackManifest(flags: Flags): void {
	const mode = requiredSlackMode(flags);
	const url = stringFlag(flags, "url") ?? "https://example.com/slack/slack/events";
	const command = slackCommandFlag(flags);
	line(slackManifestYaml(mode, url, command));
}

function optionalSlackMode(flags: Flags): SlackMode | undefined {
	const mode = stringFlag(flags, "mode");
	if (!mode) return undefined;
	if ((slackModes as readonly string[]).includes(mode)) return mode as SlackMode;
	throw new Error(`Invalid --mode: ${mode}. Expected one of: ${slackModes.join(", ")}`);
}

function requiredSlackMode(flags: Flags): SlackMode {
	const mode = optionalSlackMode(flags);
	if (!mode) throw new Error("Missing --mode. Use --mode socket or --mode http.");
	return mode;
}

function slackCommandFlag(flags: Flags): string {
	const value = stringFlag(flags, "command") ?? "/heypi";
	if (!/^\/[a-z0-9_-]{1,31}$/u.test(value)) {
		throw new Error("Invalid --command. Use / plus lowercase letters, numbers, underscores, or hyphens.");
	}
	return value;
}

function slackManifestYaml(mode: SlackMode, url: string, command: string): string {
	const settings =
		mode === "socket"
			? `  event_subscriptions:
    bot_events:
${yamlList(slackBotEvents, 6)}
  interactivity:
    is_enabled: true
  socket_mode_enabled: true`
			: `  event_subscriptions:
    request_url: ${url}
    bot_events:
${yamlList(slackBotEvents, 6)}
  interactivity:
    is_enabled: true
    request_url: ${url}
  socket_mode_enabled: false`;
	return `display_information:
  name: heypi
features:
  bot_user:
    display_name: heypi
    always_online: false
  slash_commands:
    - command: ${command}
      description: Control heypi
      usage_hint: approve <approval-id> [bypass]
      should_escape: false
oauth_config:
  scopes:
    bot:
${yamlList(slackBotScopes, 6)}
settings:
${settings}
  org_deploy_enabled: false
  token_rotation_enabled: false`;
}

function yamlList(values: readonly string[], spaces: number): string {
	const indent = " ".repeat(spaces);
	return values.map((value) => `${indent}- ${value}`).join("\n");
}

function slackEnv(): void {
	line(`SLACK_BOT_TOKEN=<slack-bot-token>
SLACK_APP_TOKEN=<slack-app-token> # Socket Mode only
SLACK_SIGNING_SECRET=<slack-signing-secret> # HTTP mode only`);
}

async function slackChannelsList(flags: Flags, positionalQuery?: string): Promise<void> {
	const token = secret(flags, "bot-token", "SLACK_BOT_TOKEN");
	const query = queryFlag(flags, positionalQuery);
	const channels = filterByQuery(
		await slackChannels(token, { includePrivate: booleanFlag(flags, "private") }),
		query,
		[(channel) => channel.id, (channel) => channel.name],
	);
	if (!channels.length)
		return line(query ? `No Slack channels matched "${query}".` : "No Slack channels visible to the bot.");
	line(
		table(
			["id", "channel", "access"],
			channels.map((channel) => [channel.id, `#${channel.name}`, channel.private ? "private" : "public"]),
		),
	);
}

async function slackUsersList(flags: Flags, positionalQuery?: string): Promise<void> {
	const token = secret(flags, "bot-token", "SLACK_BOT_TOKEN");
	const includeBots = booleanFlag(flags, "bots");
	const query = queryFlag(flags, positionalQuery);
	const users = filterByQuery(await slackUsers(token, { includeBots }), query, [
		(user) => user.id,
		(user) => user.name,
		(user) => user.realName,
	]);
	if (!users.length) return line(query ? `No Slack users matched "${query}".` : "No Slack users visible to the bot.");
	const headers = includeBots ? ["id", "user", "name", "bot"] : ["id", "user", "name"];
	const rows = users.map((user) => {
		const row = [user.id, `@${user.name}`, user.realName ?? "-"];
		if (includeBots) row.push(user.bot ? "yes" : "no");
		return row;
	});
	line(table(headers, rows));
}

async function telegramCheck(flags: Flags): Promise<void> {
	const token = secret(flags, "token", "TELEGRAM_BOT_TOKEN");
	const user = await telegramCall<TelegramUser>(token, "getMe", {});
	line(ok(`Telegram auth ok: id=${user.id} username=${user.username ? `@${user.username}` : "?"}`));
	line(warn("Telegram cannot enumerate chats; use `heypi telegram observe` after sending /start to the bot."));
}

async function telegramObserve(flags: Flags): Promise<void> {
	const token = secret(flags, "token", "TELEGRAM_BOT_TOKEN");
	const timeout = numberFlag(flags, "timeout", 60);
	await telegramCall(token, "deleteWebhook", { drop_pending_updates: false });
	const start = Date.now();
	let offset = await latestTelegramUpdate(token);
	line("Waiting for a Telegram message. Send /start to the bot or post in the target group.");
	while (Date.now() - start < timeout * 1000) {
		const updates = await telegramCall<TelegramUpdate[]>(token, "getUpdates", {
			offset: offset + 1,
			timeout: 10,
			allowed_updates: ["message", "edited_message"],
		});
		for (const update of updates) {
			offset = update.update_id;
			const msg = update.message ?? update.edited_message;
			if (!msg?.chat) continue;
			line(ok(`Observed ${msg.chat.type ?? "chat"}: ${chatName(msg.chat)} (${msg.chat.id})`));
			return;
		}
	}
	throw new Error("Timed out waiting for Telegram message");
}

async function telegramSetWebhook(flags: Flags): Promise<void> {
	const token = secret(flags, "token", "TELEGRAM_BOT_TOKEN");
	const url = requiredFlag(flags, "url");
	const secretToken = requiredFlag(flags, "secret-token");
	await telegramCall(token, "setWebhook", {
		url,
		secret_token: secretToken,
		allowed_updates: ["message", "callback_query"],
		drop_pending_updates: false,
	});
	await telegramRegisterCommands(token);
	line(ok(`Telegram webhook set: ${url}`));
	line('Configure telegram({ mode: "webhook", webhook: { secretToken: ... } }) with the same token.');
}

async function telegramDeleteWebhook(flags: Flags): Promise<void> {
	const token = secret(flags, "token", "TELEGRAM_BOT_TOKEN");
	await telegramCall(token, "deleteWebhook", { drop_pending_updates: false });
	line(ok("Telegram webhook deleted."));
}

async function discordCheck(flags: Flags): Promise<void> {
	const token = secret(flags, "token", "DISCORD_BOT_TOKEN");
	const identity = await checkDiscord(token);
	line(ok(`Discord auth ok: id=${identity.id} username=${identity.username}`));
	line(`invite: ${discordInviteUrl(identity.id)}`);
}

async function discordObserve(flags: Flags): Promise<void> {
	const token = secret(flags, "token", "DISCORD_BOT_TOKEN");
	const timeout = numberFlag(flags, "timeout", 60);
	line("Waiting for a Discord message. Send a DM or post in a channel the bot can read.");
	const found = await observeDiscord(token, timeout);
	line(ok(`Observed ${found.dm ? "dm" : "channel"}: ${found.channelName ?? found.channel}`));
	if (found.guild) line(`guild: ${found.guild}${found.guildName ? ` (${found.guildName})` : ""}`);
	line(`channel: ${found.channel}${found.channelName ? ` (${found.channelName})` : ""}`);
	line(`user: ${found.user}${found.userName ? ` (${found.userName})` : ""}`);
}

async function discordChannelsList(flags: Flags, positionalQuery?: string): Promise<void> {
	const token = secret(flags, "token", "DISCORD_BOT_TOKEN");
	const query = queryFlag(flags, positionalQuery);
	const channels = filterByQuery(await discordChannels(token), query, [
		(channel) => channel.guild,
		(channel) => channel.guildName,
		(channel) => channel.channel,
		(channel) => channel.channelName,
	]);
	if (!channels.length)
		return line(
			query ? `No Discord text channels matched "${query}".` : "No Discord text channels visible to the bot.",
		);
	line(
		table(
			["guild", "channel", "name"],
			channels.map((channel) => [channel.guild, channel.channel, `${channel.guildName} #${channel.channelName}`]),
		),
	);
}

function discordInvite(flags: Flags): void {
	const clientId = rawStringFlag("client-id") ?? stringFlag(flags, "client-id") ?? process.env.DISCORD_CLIENT_ID;
	if (!clientId) throw new Error("Missing --client-id or DISCORD_CLIENT_ID");
	line(discordInviteUrl(clientId));
}

function discordEnv(): void {
	line(`DISCORD_BOT_TOKEN=...
DISCORD_CLIENT_ID=... # invite URL helper only`);
}

async function adminLink(flags: Flags): Promise<void> {
	const stateRoot = adminStateRoot(flags);
	const explicitUrl = stringFlag(flags, "url") ?? process.env.HEYPI_ADMIN_URL;
	const server = await selectAdminServer(stateRoot, flags, explicitUrl);
	const baseUrl = explicitUrl ?? server?.url;
	if (!baseUrl) {
		throw new Error(`no running admin server found for state root ${stateRoot}; start heypi`);
	}
	const secretValue = process.env.HEYPI_ADMIN_SECRET?.trim() || readAdminSecret(stateRoot);
	const signed = createAdminLoginToken(secretValue, 5 * 60_000, { stateRoot });
	const body = {
		url: adminLoginUrl(baseUrl, signed.token, server?.adminPath ?? "/admin"),
		expiresAt: signed.expiresAt,
	};
	line(booleanFlag(flags, "json") ? JSON.stringify(body, null, 2) : body.url);
}

async function jobsList(flags: Flags): Promise<void> {
	const repos = jobRepos(flags);
	const jobs = await repos.jobs.list({ agent: stringFlag(flags, "agent"), limit: numberFlag(flags, "limit", 100) });
	if (booleanFlag(flags, "json")) {
		const rows = [];
		for (const job of jobs) {
			const last = await repos.runs.lastForJob({ agent: job.agent, id: job.id });
			rows.push({ ...job, lastRun: last ?? null });
		}
		return line(JSON.stringify(rows, null, 2));
	}
	if (!jobs.length) return line("No jobs found.");
	const tableRows = [];
	for (const job of jobs) {
		const last = await repos.runs.lastForJob({ agent: job.agent, id: job.id });
		tableRows.push([
			job.agent,
			job.id,
			job.kind,
			job.state,
			fmtTime(job.nextAt),
			fmtTime(job.lastAt),
			last ? `${last.state}/${last.deliveryState}` : "-",
		]);
	}
	line(table(["agent", "id", "kind", "state", "next", "last", "last_run"], tableRows));
}

async function jobsState(flags: Flags, id: string, state: "active" | "paused"): Promise<void> {
	const repos = jobRepos(flags);
	const job = await repos.jobs.get({ agent: stringFlag(flags, "agent"), id });
	if (!job) throw new Error(`job not found: ${id}`);
	await repos.jobs.setState({ agent: job.agent, id }, state);
	line(ok(`job ${id} ${state}`));
}

async function jobsShow(flags: Flags, id: string): Promise<void> {
	const repos = jobRepos(flags);
	const job = await repos.jobs.get({ agent: stringFlag(flags, "agent"), id });
	if (!job) throw new Error(`job not found: ${id}`);
	const last = await repos.runs.lastForJob({ agent: job.agent, id });
	const row = { ...job, lastRun: last ?? null };
	if (booleanFlag(flags, "json")) return line(JSON.stringify(row, null, 2));
	line(
		[
			`agent: ${job.agent}`,
			`id: ${job.id}`,
			`kind: ${job.kind}`,
			`state: ${job.state}`,
			`next: ${fmtTime(job.nextAt)}`,
			`last: ${fmtTime(job.lastAt)}`,
			`idle_ms: ${job.idleMs ?? "-"}`,
			`targets: ${job.target ?? "-"}`,
			`scope: ${job.scope ?? "-"}`,
			`prompt: ${job.prompt}`,
			`last_run: ${last ? `${last.state}/${last.deliveryState}` : "-"}`,
		].join("\n"),
	);
}

async function jobsRun(flags: Flags, id: string): Promise<void> {
	const repos = jobRepos(flags);
	const job = await repos.jobs.get({ agent: stringFlag(flags, "agent"), id });
	if (!job) throw new Error(`job not found: ${id}`);
	const dueAt = Date.now();
	const result = await enqueueJobRuns({
		agent: job.agent,
		store: { threads: repos.threads, jobRuns: repos.runs },
		job,
		dueAt,
		skipActiveHeartbeat: true,
	});
	const skipped = result.skipped ? `, skipped ${result.skipped}` : "";
	line(
		ok(
			`job ${id} queued ${result.inserted}/${result.targets} target(s)${skipped}; a running heypi app will execute them`,
		),
	);
}

function evalsList(flags: Flags): void {
	const rows = filterEvals(loadCliEvals(flags), flags);
	if (booleanFlag(flags, "json")) {
		line(JSON.stringify(rows.map(evalSummary), null, 2));
		return;
	}
	if (!rows.length) {
		line("No evals found.");
		return;
	}
	line(
		table(
			["name", "tags", "expect"],
			rows.map((row) => [row.name, row.tags?.join(",") || "-", expectLabel(row.expect)]),
		),
	);
}

function evalsShow(flags: Flags, name: string): void {
	const evaluation = loadCliEvals(flags).find((row) => row.name === name);
	if (!evaluation) throw new Error(`eval not found: ${name}`);
	if (booleanFlag(flags, "json")) {
		line(JSON.stringify(evalSummary(evaluation), null, 2));
		return;
	}
	line(
		[
			`name: ${evaluation.name}`,
			`tags: ${evaluation.tags?.join(",") || "-"}`,
			`timeout_ms: ${evaluation.timeoutMs ?? "-"}`,
			`prompt: ${evaluation.prompt}`,
			`expect: ${expectLabel(evaluation.expect)}`,
		].join("\n"),
	);
}

function evalsCheck(flags: Flags): void {
	const rows = filterEvals(loadCliEvals(flags), flags);
	const invalid = rows.filter((row) => !row.prompt.trim());
	if (invalid.length) throw new Error(`evals missing prompt: ${invalid.map((row) => row.name).join(", ")}`);
	const body = { ok: true, evals: rows.length };
	line(booleanFlag(flags, "json") ? JSON.stringify(body, null, 2) : ok(`${rows.length} eval(s) valid`));
}

function loadCliEvals(flags: Flags): EvalConfig[] {
	const agent = stringFlag(flags, "agent") ?? "./agent";
	return loadEvals(resolve(invocationRoot(), agent, "evals"));
}

function filterEvals(rows: EvalConfig[], flags: Flags): EvalConfig[] {
	const tag = stringFlag(flags, "tag");
	if (!tag) return rows;
	return rows.filter((row) => row.tags?.includes(tag));
}

function evalSummary(input: EvalConfig): Record<string, unknown> {
	return {
		name: input.name,
		prompt: input.prompt,
		tags: input.tags ?? [],
		timeoutMs: input.timeoutMs,
		expect: expectSummary(input.expect),
	};
}

function expectSummary(input: EvalConfig["expect"]): unknown {
	if (!input) return undefined;
	if (typeof input === "function") return "custom";
	if (Array.isArray(input)) return input.map(expectSummary);
	return Object.fromEntries(
		Object.entries(input).map(([key, value]) => [key, value instanceof RegExp ? value.toString() : value]),
	);
}

function expectLabel(input: EvalConfig["expect"]): string {
	if (!input) return "-";
	const rows = Array.isArray(input) ? input : [input];
	return rows.map(oneExpectLabel).join(",");
}

function oneExpectLabel(input: EvalExpect): string {
	if (typeof input === "function") return "custom";
	return Object.entries(input)
		.map(([key, value]) => `${key}:${value instanceof RegExp ? value.toString() : String(value)}`)
		.join("+");
}

async function approvalsList(flags: Flags): Promise<void> {
	const approvals = approvalRepo(flags);
	const rows = await approvals.listPending({
		agent: stringFlag(flags, "agent"),
		limit: numberFlag(flags, "limit", 25),
	});
	if (booleanFlag(flags, "json")) return line(JSON.stringify(rows, null, 2));
	if (!rows.length) return line("No pending approvals.");
	line(
		table(
			["id", "channel", "runtime", "command", "reason", "requested", "expires"],
			rows.map((row) => [
				row.id,
				row.channel,
				row.runtime,
				row.command,
				row.reason,
				fmtTime(row.requestedAt),
				fmtTime(row.expiresAt),
			]),
		),
	);
}

async function approvalsShow(flags: Flags, id: string): Promise<void> {
	const approval = await approvalRepo(flags).get(id, { agent: stringFlag(flags, "agent") });
	if (!approval) throw new Error(`approval not found: ${id}`);
	if (booleanFlag(flags, "json")) return line(JSON.stringify(approval, null, 2));
	line(
		[
			`id: ${approval.id}`,
			`state: ${approval.state}`,
			`channel: ${approval.channel}`,
			`thread: ${approval.threadId ?? "-"}`,
			`call: ${approval.callId}`,
			`runtime: ${approval.runtime}`,
			`command: ${approval.command}`,
			`reason: ${approval.reason}`,
			`requested_by: ${approval.requestedBy ?? "-"}`,
			`requested: ${fmtTime(approval.requestedAt)}`,
			`expires: ${fmtTime(approval.expiresAt)}`,
			`resolved_by: ${approval.resolvedBy ?? "-"}`,
			`resolved: ${fmtTime(approval.resolvedAt)}`,
		].join("\n"),
	);
}

async function approvalBypassesList(flags: Flags): Promise<void> {
	const rows = await approvalBypassRepo(flags).listActive({
		agent: stringFlag(flags, "agent"),
		limit: numberFlag(flags, "limit", 25),
	});
	if (booleanFlag(flags, "json")) return line(JSON.stringify(rows, null, 2));
	if (!rows.length) return line("No active approval bypasses.");
	line(
		table(
			["id", "agent", "scope", "channel", "thread", "actor", "created_by", "expires"],
			rows.map((row) => [
				row.id,
				row.agent,
				row.scope,
				row.channel,
				row.threadId ?? "-",
				row.actor ?? "-",
				row.createdBy,
				fmtTime(row.expiresAt),
			]),
		),
	);
}

function jobRepos(flags: Flags): { jobs: JobRepo; runs: JobRunRepo; threads: ThreadRepo } {
	const db = dbFor(requiredFlag(flags, "db"));
	return { jobs: new JobRepo(db), runs: new JobRunRepo(db), threads: new ThreadRepo(db) };
}

function approvalRepo(flags: Flags): ApprovalRepo {
	return new ApprovalRepo(dbFor(requiredFlag(flags, "db")));
}

function approvalBypassRepo(flags: Flags): ApprovalBypassRepo {
	return new ApprovalBypassRepo(dbFor(requiredFlag(flags, "db")));
}

async function checkDb(path: string): Promise<string> {
	try {
		const db = dbFor(path);
		await migrate(db);
		return ok(`database ok: ${path}`);
	} catch (error) {
		return fail(`database failed: ${message(error)}`);
	}
}

function dbFor(path: string) {
	return openDb({ url: `file:${path}` });
}

async function slackCall<T>(token: string, method: string, body: Record<string, unknown>): Promise<T> {
	const response = await fetch(`https://slack.com/api/${method}`, {
		method: "POST",
		headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
		body: JSON.stringify(body),
	});
	const parsed = (await response.json()) as { ok?: boolean; error?: string } & T;
	if (!response.ok || !parsed.ok) throw new Error(parsed.error ?? `Slack API failed: ${response.status}`);
	return parsed;
}

async function telegramCall<T>(token: string, method: string, body: Record<string, unknown>): Promise<T> {
	const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});
	const parsed = (await response.json()) as { ok?: boolean; result?: T; description?: string };
	if (!response.ok || !parsed.ok || parsed.result === undefined) {
		throw new Error(parsed.description ?? `Telegram API failed: ${response.status}`);
	}
	return parsed.result;
}

async function telegramRegisterCommands(token: string): Promise<void> {
	await telegramCall(token, "setMyCommands", {
		commands: COMMANDS.map((command) => ({ command: command.name, description: command.description })),
	});
}

async function latestTelegramUpdate(token: string): Promise<number> {
	const updates = await telegramCall<TelegramUpdate[]>(token, "getUpdates", { offset: -1, limit: 1, timeout: 0 });
	return updates.at(-1)?.update_id ?? 0;
}

function requiredFlag(flags: Flags, name: string): string {
	const value = stringFlag(flags, name);
	if (!value) throw new Error(`Missing --${name}`);
	return value;
}

function stringFlag(flags: Flags, name: string): string | undefined {
	const value = flags[name] ?? flags[camel(name)];
	if (typeof value === "number" && Number.isFinite(value)) return String(value);
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function rawStringFlag(name: string): string | undefined {
	const long = `--${name}`;
	for (let index = 2; index < process.argv.length; index++) {
		const arg = process.argv[index];
		if (arg === long) {
			const next = process.argv[index + 1];
			return next && !next.startsWith("-") ? next : undefined;
		}
		if (arg.startsWith(`${long}=`)) return arg.slice(long.length + 1) || undefined;
	}
	return undefined;
}

function booleanFlag(flags: Flags, name: string): boolean {
	return flags[name] === true || flags[camel(name)] === true;
}

function queryFlag(flags: Flags, positionalQuery?: unknown): string | undefined {
	return (stringFlag(flags, "query") ?? queryText(positionalQuery))?.trim().toLowerCase() || undefined;
}

function queryText(input: unknown): string | undefined {
	if (typeof input === "number" && Number.isFinite(input)) return String(input);
	return typeof input === "string" ? input : undefined;
}

function filterByQuery<T>(rows: T[], query: string | undefined, fields: Array<(row: T) => string | undefined>): T[] {
	if (!query) return rows;
	return rows.filter((row) =>
		fields.some((field) => {
			const value = field(row);
			return value ? value.toLowerCase().includes(query) : false;
		}),
	);
}

function helpText(): string {
	return `heypi ${VERSION}

Usage:
  heypi init
  heypi dev [index.ts]
  heypi start [index.ts]
  heypi check [--env .env] [--db ./state/heypi.db] [--runtime-root ./workspace]
  heypi status --db ./state/heypi.db [--agent <id>] [--runtime-root ./workspace] [--json]
  heypi db check --db ./state/heypi.db
  heypi db migrate --db ./state/heypi.db
  heypi slack check [--env .env] [--mode socket|http]
  heypi slack manifest --mode socket
  heypi slack manifest --mode http --url https://host/slack/slack/events
  heypi slack channels [devops] [--env .env] [--private] [--query devops]
  heypi slack users [ronan] [--env .env] [--bots] [--query ronan]
  heypi slack env
  heypi telegram check [--env .env]
  heypi telegram observe [--env .env] [--timeout 60]
  heypi telegram set-webhook [--env .env] --url https://host/telegram/telegram/webhook --secret-token <token>
  heypi telegram delete-webhook [--env .env]
  heypi discord check [--env .env]
  heypi discord observe [--env .env] [--timeout 60]
  heypi discord channels [engineering] [--env .env] [--query engineering]
  heypi admin link [--state ./state] [--url http://127.0.0.1:3000] [--pid <pid>] [--json]
  heypi approvals list --db ./state/heypi.db [--agent <id>] [--json]
  heypi approvals show <id> --db ./state/heypi.db [--agent <id>] [--json]
  heypi approvals bypasses --db ./state/heypi.db [--agent <id>] [--json]
  heypi jobs list --db ./state/heypi.db [--agent <id>] [--json]
  heypi jobs show <id> --db ./state/heypi.db [--agent <id>] [--json]
  heypi jobs run <id> --db ./state/heypi.db [--agent <id>]
  heypi jobs pause <id> --db ./state/heypi.db [--agent <id>]
  heypi jobs resume <id> --db ./state/heypi.db [--agent <id>]
  heypi eval list [--agent ./agent] [--tag smoke] [--json]
  heypi eval show <name> [--agent ./agent] [--json]
  heypi eval check [--agent ./agent] [--tag smoke] [--json]`;
}

function numberFlag(flags: Flags, name: string, fallback: number): number {
	const raw = stringFlag(flags, name);
	if (!raw) return fallback;
	const value = Number(raw);
	if (!Number.isFinite(value)) throw new Error(`Invalid --${name}: ${raw}`);
	return value;
}

function optionalNumberFlag(flags: Flags, name: string): number | undefined {
	const raw = stringFlag(flags, name);
	if (!raw) return undefined;
	const value = Number(raw);
	if (!Number.isFinite(value)) throw new Error(`Invalid --${name}: ${raw}`);
	return value;
}

function secret(flags: Flags, flag: string, env: string): string {
	const value = stringFlag(flags, flag) ?? process.env[env];
	if (!value) throw new Error(`Missing --${flag} or ${env}`);
	return value;
}

function optionalSecret(flags: Flags, flag: string, env: string): string | undefined {
	const value = stringFlag(flags, flag) ?? process.env[env];
	return value?.trim() || undefined;
}

function adminStateRoot(flags: Flags): string {
	const explicit = stringFlag(flags, "state") ?? process.env.HEYPI_STATE_ROOT;
	const searchRoot = invocationRoot();
	if (explicit) return isAbsolute(explicit) ? resolve(explicit) : resolve(searchRoot, explicit);
	const local = resolve(searchRoot, "state");
	if (existsSync(join(local, "admin"))) return local;
	const discovered = discoverStateRoots(searchRoot);
	if (discovered.length === 1) return discovered[0];
	if (discovered.length > 1) {
		throw new Error(
			`multiple heypi state roots found; pass --state:\n${discovered.map((root) => `  ${root}`).join("\n")}`,
		);
	}
	throw new Error("no heypi admin state found; pass --state or run from the app folder");
}

function invocationRoot(): string {
	return process.env.INIT_CWD ? resolve(process.env.INIT_CWD) : resolve(".");
}

async function selectAdminServer(
	stateRoot: string,
	flags: Flags,
	urlOverride?: string,
): Promise<{ pid: number; url: string; adminPath: string } | undefined> {
	const requestedPid = optionalNumberFlag(flags, "pid");
	const matched: Array<{ path: string; descriptor: AdminServerDescriptor }> = [];
	const unavailable: AdminServerDescriptor[] = [];
	for (const row of readAdminServerDescriptors(stateRoot)) {
		if (requestedPid !== undefined && row.descriptor.pid !== requestedPid) continue;
		if (!processAlive(row.descriptor.pid)) {
			rmSync(row.path, { force: true });
			continue;
		}
		const probe = await adminServerProbe(urlOverride ? { ...row.descriptor, url: urlOverride } : row.descriptor);
		if (probe === "matched") {
			matched.push(row);
			continue;
		}
		if (probe === "mismatched") {
			if (!urlOverride) rmSync(row.path, { force: true });
			continue;
		}
		unavailable.push(row.descriptor);
	}
	if (requestedPid !== undefined) {
		const row = matched.find((item) => item.descriptor.pid === requestedPid);
		if (row) return row.descriptor;
		const stalled = unavailable.find((item) => item.pid === requestedPid);
		if (stalled) {
			const url = urlOverride ?? stalled.url;
			throw new Error(
				`admin server pid ${requestedPid} was found for state root ${stateRoot}, but did not respond at ${url}`,
			);
		}
		throw new Error(
			urlOverride
				? `admin server pid ${requestedPid} did not match the admin instance at ${urlOverride}`
				: `admin server pid ${requestedPid} is not running for state root ${stateRoot}`,
		);
	}
	if (matched.length === 0) {
		if (unavailable.length) {
			if (urlOverride) {
				throw new Error(
					`admin server descriptor found for state root ${stateRoot}, but none responded at ${urlOverride}`,
				);
			}
			throw new Error(
				`found ${unavailable.length} admin server descriptor(s) for state root ${stateRoot}, but none responded; check that heypi is reachable from this shell or pass --url`,
			);
		}
		if (urlOverride) throw new Error(`no admin server descriptor matched ${urlOverride} for state root ${stateRoot}`);
		return undefined;
	}
	if (matched.length > 1) {
		throw new Error(
			`multiple admin servers are running for state root ${stateRoot}; pass --pid:\n${matched
				.map((row) => `  ${row.descriptor.pid}\t${row.descriptor.url}`)
				.join("\n")}`,
		);
	}
	return matched[0].descriptor;
}

type AdminServerProbe = "matched" | "mismatched" | "unavailable";

async function adminServerProbe(descriptor: AdminServerDescriptor): Promise<AdminServerProbe> {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), 2_000);
	try {
		const response = await fetch(adminProbeUrl(descriptor.url, descriptor.adminPath), {
			method: "GET",
			redirect: "manual",
			signal: controller.signal,
		});
		const instanceId = response.headers.get("x-heypi-admin-instance");
		if (instanceId === descriptor.instanceId) return "matched";
		return instanceId ? "mismatched" : "unavailable";
	} catch {
		return "unavailable";
	} finally {
		clearTimeout(timeout);
	}
}

function adminProbeUrl(baseUrl: string, adminPath: string): string {
	const url = new URL(baseUrl);
	url.pathname = `${adminPath.replace(/\/+$/u, "")}/login`;
	url.search = "";
	url.hash = "";
	return url.toString();
}

function discoverStateRoots(root: string, depth = 5): string[] {
	const out = new Set<string>();
	const walk = (dir: string, remaining: number) => {
		const stateRoot = join(dir, "state");
		if (existsSync(join(stateRoot, "admin"))) out.add(stateRoot);
		if (remaining <= 0) return;
		let entries: string[];
		try {
			entries = readdirSync(dir);
		} catch {
			return;
		}
		for (const name of entries) {
			if ([".git", "dist", "node_modules"].includes(name)) continue;
			const path = join(dir, name);
			try {
				if (statSync(path).isDirectory()) walk(path, remaining - 1);
			} catch {}
		}
	};
	walk(root, depth);
	return [...out].sort();
}

function camel(name: string): string {
	return name.replace(/-([a-z])/g, (_, char: string) => char.toUpperCase());
}

function packageVersion(): string {
	try {
		const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
			version?: unknown;
		};
		if (typeof pkg.version === "string" && pkg.version.trim()) return pkg.version;
	} catch {}
	return "0.0.0";
}

function envCheck(name: string): string {
	return process.env[name] ? ok(`${name} present`) : warn(`${name} missing`);
}

function checkDir(path: string, label: string): string {
	try {
		const stat = statSync(path);
		return stat.isDirectory() ? ok(`${label} exists: ${path}`) : fail(`${label} is not a directory: ${path}`);
	} catch {
		return warn(`${label} missing: ${path}`);
	}
}

function fmtTime(value: number | null): string {
	return value ? new Date(value).toISOString() : "-";
}

function chatName(chat: TelegramChat): string {
	return (
		chat.title ?? chat.username ?? ([chat.first_name, chat.last_name].filter(Boolean).join(" ") || String(chat.id))
	);
}

function ok(text: string): string {
	return `${pc.green("ok")}: ${text}`;
}

function warn(text: string): string {
	return `${pc.yellow("warn")}: ${text}`;
}

function fail(text: string): string {
	return `${pc.red("fail")}: ${text}`;
}

function line(text: string): void {
	process.stdout.write(`${text}\n`);
}

function table(headers: string[], rows: string[][]): string {
	const widths = headers.map((header, index) =>
		Math.max(stripAnsi(header).length, ...rows.map((row) => stripAnsi(row[index] ?? "").length)),
	);
	const format = (row: string[]) =>
		row
			.map((cell, index) => cell.padEnd(widths[index]))
			.join("  ")
			.trimEnd();
	const divider = widths.map((width) => "-".repeat(width));
	return [format(headers.map((header) => pc.bold(header))), format(divider), ...rows.map(format)].join("\n");
}

function stripAnsi(value: string): string {
	return value.replace(/\u001b\[[0-9;]*m/g, "");
}

function message(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

type TelegramUser = {
	id: number;
	username?: string;
};

type TelegramChat = {
	id: number;
	type?: string;
	title?: string;
	username?: string;
	first_name?: string;
	last_name?: string;
};

type TelegramMessage = {
	chat: TelegramChat;
};

type TelegramUpdate = {
	update_id: number;
	message?: TelegramMessage;
	edited_message?: TelegramMessage;
};

main().catch((error) => {
	process.stderr.write(`error: ${message(error)}\n`);
	process.exitCode = 1;
});

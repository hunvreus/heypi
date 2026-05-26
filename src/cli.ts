#!/usr/bin/env node
import { existsSync, statSync } from "node:fs";
import { loadEnvFile } from "node:process";
import { cac } from "cac";
import { DEFAULT_ADMIN_CONTROL_PATH, readAdminControl } from "./admin/control.js";
import {
	discordCheck as checkDiscord,
	discordChannels,
	discordInviteUrl,
	discordObserve as observeDiscord,
} from "./io/discord-discovery.js";
import { slackChannels } from "./io/slack-discovery.js";
import { openDb } from "./store/db.js";
import { migrate } from "./store/migrate.js";
import { ApprovalRepo } from "./store/repo-approval.js";
import { JobRepo, JobRunRepo } from "./store/repo-job.js";

const VERSION = "0.1.0-alpha.0";

type Flags = Record<string, string | boolean>;

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
	cli.command("check", "Run local setup checks")
		.option("--env <path>", "Load env file")
		.option("--db <path>", "SQLite database path")
		.option("--runtime-root <path>", "Runtime workspace path")
		.action(withEnv(check));
	cli.command("db <action>", "Database commands: check, migrate")
		.option("--db <path>", "SQLite database path")
		.action((action: string, flags: Flags) =>
			withEnv((input) => {
				if (action === "check") return dbCheck(input);
				if (action === "migrate") return dbMigrate(input);
				throw new Error(`Unknown command: db ${action}`);
			})(flags),
		);
	cli.command("slack <action>", "Slack commands: check, manifest, channels, env")
		.option("--env <path>", "Load env file")
		.option("--bot-token <token>", "Slack bot token")
		.option("--app-token <token>", "Slack app token")
		.option("--signing-secret <secret>", "Slack signing secret")
		.option("--url <url>", "Slack events URL")
		.option("--private", "Include private channels visible to the bot")
		.action((action: string, flags: Flags) =>
			withEnv((input) => {
				if (action === "check") return slackCheck(input);
				if (action === "manifest") return slackManifest(input);
				if (action === "channels") return slackChannelsList(input);
				if (action === "env") return slackEnv();
				throw new Error(`Unknown command: slack ${action}`);
			})(flags),
		);
	cli.command("telegram <action>", "Telegram commands: check, observe")
		.option("--env <path>", "Load env file")
		.option("--token <token>", "Telegram bot token")
		.option("--timeout <seconds>", "Timeout in seconds")
		.action((action: string, flags: Flags) =>
			withEnv((input) => {
				if (action === "check") return telegramCheck(input);
				if (action === "observe") return telegramObserve(input);
				throw new Error(`Unknown command: telegram ${action}`);
			})(flags),
		);
	cli.command("discord <action>", "Discord commands: check, observe, channels, invite, env")
		.option("--env <path>", "Load env file")
		.option("--token <token>", "Discord bot token")
		.option("--client-id <id>", "Discord application/client ID")
		.option("--timeout <seconds>", "Timeout in seconds")
		.action((action: string, flags: Flags) =>
			withEnv((input) => {
				if (action === "check") return discordCheck(input);
				if (action === "observe") return discordObserve(input);
				if (action === "channels") return discordChannelsList(input);
				if (action === "invite") return discordInvite(input);
				if (action === "env") return discordEnv();
				throw new Error(`Unknown command: discord ${action}`);
			})(flags),
		);
	cli.command("admin <action>", "Admin commands: link")
		.option("--env <path>", "Load env file")
		.option("--control <path>", "Admin control file path")
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
	cli.command("approvals <action> [id]", "Approval commands: list, show")
		.option("--db <path>", "SQLite database path")
		.option("--limit <count>", "Maximum approvals to list")
		.option("--json", "Print JSON")
		.action((action: string, id: string | undefined, flags: Flags) =>
			withEnv((input) => {
				if (action === "list") return approvalsList(input);
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
	const path = stringFlag(flags, "env") ?? ".env";
	if (existsSync(path)) loadEnvFile(path);
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
	const auth = await slackCall<{ ok: boolean; team?: string; user?: string; bot_id?: string }>(token, "auth.test", {});
	line(ok(`Slack auth ok: team=${auth.team ?? "?"} user=${auth.user ?? "?"} bot=${auth.bot_id ?? "?"}`));
	line(
		signingSecret
			? ok("SLACK_SIGNING_SECRET present")
			: warn("SLACK_SIGNING_SECRET missing; required only for HTTP mode"),
	);
	line(
		appToken
			? ok("SLACK_APP_TOKEN present for Socket Mode")
			: warn("SLACK_APP_TOKEN missing; needed only for Socket Mode"),
	);
}

function slackManifest(flags: Flags): void {
	const url = stringFlag(flags, "url") ?? "https://example.com/slack/slack/events";
	line(`display_information:
  name: heypi
features:
  bot_user:
    display_name: heypi
    always_online: false
oauth_config:
  scopes:
    bot:
      - app_mentions:read
      - channels:history
      - channels:read
      - chat:write
      - chat:write.public
      - files:read
      - files:write
      - im:history
      - reactions:write
settings:
  event_subscriptions:
    request_url: ${url}
    bot_events:
      - app_mention
      - message.channels
      - message.im
  interactivity:
    is_enabled: true
    request_url: ${url}
  socket_mode_enabled: false`);
}

function slackEnv(): void {
	line(`SLACK_BOT_TOKEN=<slack-bot-token>
SLACK_APP_TOKEN=<slack-app-token> # Socket Mode only`);
}

async function slackChannelsList(flags: Flags): Promise<void> {
	const token = secret(flags, "bot-token", "SLACK_BOT_TOKEN");
	const channels = await slackChannels(token, { includePrivate: booleanFlag(flags, "private") });
	if (!channels.length) return line("No Slack channels visible to the bot.");
	for (const channel of channels) {
		const row = [channel.id, `#${channel.name}`, `targets: { slack: { channels: ["${channel.id}"] } }`];
		if (channel.private) row.splice(2, 0, "private");
		line(row.join("\t"));
	}
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
			line(`targets: { telegram: { channels: ["${msg.chat.id}"] } }`);
			return;
		}
	}
	throw new Error("Timed out waiting for Telegram message");
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
	line(`targets: { discord: { channels: ["${found.channel}"] } }`);
}

async function discordChannelsList(flags: Flags): Promise<void> {
	const token = secret(flags, "token", "DISCORD_BOT_TOKEN");
	const channels = await discordChannels(token);
	if (!channels.length) return line("No Discord text channels visible to the bot.");
	for (const channel of channels) {
		line(`${channel.guild}\t${channel.channel}\t${channel.guildName} #${channel.channelName}`);
	}
}

function discordInvite(flags: Flags): void {
	const clientId = stringFlag(flags, "client-id") ?? process.env.DISCORD_CLIENT_ID;
	if (!clientId) throw new Error("Missing --client-id or DISCORD_CLIENT_ID");
	line(discordInviteUrl(clientId));
}

function discordEnv(): void {
	line(`DISCORD_BOT_TOKEN=...
DISCORD_CLIENT_ID=... # invite URL helper only`);
}

async function adminLink(flags: Flags): Promise<void> {
	const controlPath = stringFlag(flags, "control") ?? process.env.HEYPI_ADMIN_CONTROL ?? DEFAULT_ADMIN_CONTROL_PATH;
	const control = readAdminControl(controlPath);
	const baseUrl = stringFlag(flags, "url") ?? process.env.HEYPI_ADMIN_URL ?? control.url;
	const endpoint = adminControlEndpoint(baseUrl);
	let response: Response;
	try {
		response = await fetch(endpoint, {
			method: "POST",
			headers: { authorization: `Bearer ${control.token}`, accept: "application/json" },
		});
	} catch (error) {
		throw new Error(
			`admin server is not reachable at ${baseUrl}; make sure the heypi process is running, or pass --url/--control. ${message(error)}`,
		);
	}
	const parsed = (await response.json().catch(() => ({}))) as Partial<AdminLinkResponse> & { error?: string };
	if (!response.ok) throw new Error(parsed.error ?? `admin link request failed: ${response.status}`);
	if (typeof parsed.url !== "string" || typeof parsed.expiresAt !== "number") {
		throw new Error("admin link response was invalid");
	}
	const body = { url: parsed.url, expiresAt: parsed.expiresAt };
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
	for (const job of jobs) {
		const last = await repos.runs.lastForJob({ agent: job.agent, id: job.id });
		line(
			[
				job.agent,
				job.id,
				job.kind,
				job.state,
				`next=${fmtTime(job.nextAt)}`,
				`last=${fmtTime(job.lastAt)}`,
				last ? `last_run=${last.state}/${last.deliveryState}` : "last_run=-",
			].join("\t"),
		);
	}
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
	await repos.jobs.runNow({ agent: job.agent, id });
	line(ok(`job ${id} marked due; a running heypi app will execute it on the next scheduler tick`));
}

async function approvalsList(flags: Flags): Promise<void> {
	const approvals = approvalRepo(flags);
	const rows = await approvals.listPending({ limit: numberFlag(flags, "limit", 25) });
	if (booleanFlag(flags, "json")) return line(JSON.stringify(rows, null, 2));
	if (!rows.length) return line("No pending approvals.");
	for (const row of rows) {
		line(
			[
				row.id,
				row.channel,
				row.runtime,
				row.command,
				row.reason,
				`requested=${fmtTime(row.requestedAt)}`,
				`expires=${fmtTime(row.expiresAt)}`,
			].join("\t"),
		);
	}
}

async function approvalsShow(flags: Flags, id: string): Promise<void> {
	const approval = await approvalRepo(flags).get(id);
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

function jobRepos(flags: Flags): { jobs: JobRepo; runs: JobRunRepo } {
	const db = dbFor(requiredFlag(flags, "db"));
	return { jobs: new JobRepo(db), runs: new JobRunRepo(db) };
}

function approvalRepo(flags: Flags): ApprovalRepo {
	return new ApprovalRepo(dbFor(requiredFlag(flags, "db")));
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
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function booleanFlag(flags: Flags, name: string): boolean {
	return flags[name] === true || flags[camel(name)] === true;
}

function helpText(): string {
	return `heypi ${VERSION}

Usage:
  heypi check [--env .env] [--db heypi.db] [--runtime-root ./workspace]
  heypi db check --db heypi.db
  heypi db migrate --db heypi.db
  heypi slack check [--env .env]
  heypi slack manifest [--url https://host/slack/slack/events]
  heypi slack channels [--env .env] [--private]
  heypi slack env
  heypi telegram check [--env .env]
  heypi telegram observe [--env .env] [--timeout 60]
  heypi discord check [--env .env]
  heypi discord observe [--env .env] [--timeout 60]
  heypi discord channels [--env .env]
  heypi admin link [--control .heypi/admin-control.json] [--url http://127.0.0.1:3000]
  heypi approvals list --db heypi.db [--json]
  heypi approvals show <id> --db heypi.db [--json]
  heypi jobs list --db heypi.db [--agent <id>] [--json]
  heypi jobs show <id> --db heypi.db [--agent <id>] [--json]
  heypi jobs run <id> --db heypi.db [--agent <id>]
  heypi jobs pause <id> --db heypi.db [--agent <id>]
  heypi jobs resume <id> --db heypi.db [--agent <id>]`;
}

function numberFlag(flags: Flags, name: string, fallback: number): number {
	const raw = stringFlag(flags, name);
	if (!raw) return fallback;
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

function adminControlEndpoint(input: string): string {
	const url = new URL(input);
	url.pathname = "/admin/_control/links";
	url.search = "";
	url.hash = "";
	return url.toString();
}

function camel(name: string): string {
	return name.replace(/-([a-z])/g, (_, char: string) => char.toUpperCase());
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
	return `ok: ${text}`;
}

function warn(text: string): string {
	return `warn: ${text}`;
}

function fail(text: string): string {
	return `fail: ${text}`;
}

function line(text: string): void {
	process.stdout.write(`${text}\n`);
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

type AdminLinkResponse = {
	url: string;
	expiresAt: number;
};

main().catch((error) => {
	process.stderr.write(`error: ${message(error)}\n`);
	process.exitCode = 1;
});

import { existsSync } from "node:fs";
import { loadEnvFile } from "node:process";
import { agentFrom, consoleLogger, coreTools, createHeypi, runHeypi, slack, workspace } from "@hunvreus/heypi";
import { createHostContext, createHostTools } from "./tools/host.js";
import { createRunbookTools } from "./tools/runbook.js";

loadEnv(".env");

function loadEnv(path: string): void {
	if (existsSync(path)) loadEnvFile(path);
}

function required(name: string): string {
	const value = process.env[name];
	if (!value) throw new Error(`Missing env var: ${name}`);
	return value;
}

function optional(name: string): string | undefined {
	return process.env[name]?.trim() || undefined;
}

function list(name: string): string[] {
	return (process.env[name] ?? "")
		.split(",")
		.map((value) => value.trim())
		.filter(Boolean);
}

const commandPolicy = {
	allow: [
		/^\s*curl\s+-I\b[^;&|]*\bhttps?:\/\/(?:127\.0\.0\.1|localhost)(?::\d+)?(?:\/|\b)\s*(?:\|\|\s*true\s*)?$/i,
		/^\s*curl\s+[^;&|]*--head\b[^;&|]*\bhttps?:\/\/(?:127\.0\.0\.1|localhost)(?::\d+)?(?:\/|\b)\s*(?:\|\|\s*true\s*)?$/i,
	],
	approve: [
		/\bsystemctl\s+(restart|stop|start|reload|enable|disable|mask|unmask)\b/i,
		/\bdocker\s+(restart|stop|rm|compose\s+up|compose\s+down|prune)\b/i,
		/\bapt(?:-get)?\s+(install|remove|purge|upgrade|dist-upgrade|autoremove)\b/i,
		/\byum\s+(install|remove|update|upgrade)\b/i,
		/\bufw\s+(allow|deny|delete|enable|disable|reload|reset)\b/i,
		/\bfirewall-cmd\b/i,
		/\biptables\b/i,
		/\bnft\s+(add|delete|flush|insert|replace)\b/i,
	],
	block: [/\bcat\s+.*(?:\.env|id_rsa|id_ed25519)\b/i, /\bchmod\s+777\b/i],
};

const stateRoot = "./state";
const hostTools = createHostTools({
	root: stateRoot,
	commandPolicy,
	timeoutMs: 60_000,
});
const runbookTools = createRunbookTools({ root: "./agent/runbooks" });
const hostContext = createHostContext({ root: stateRoot });
const log = consoleLogger({ level: "debug", format: "pretty" });
const jobChannel = optional("HEYPI_SLACK_JOB_CHANNEL");

if (!jobChannel) {
	log.warn("example.jobs_disabled", {
		missing: "HEYPI_SLACK_JOB_CHANNEL",
		reason: "Slack example jobs require an explicit target channel",
	});
}

const app = createHeypi({
	state: { root: stateRoot },
	logger: log,
	admin: true,
	secrets: {
		url: "http://127.0.0.1:3000/secret",
		serve: true,
	},
	adapters: [
		slack({
			botToken: required("SLACK_BOT_TOKEN"),
			mode: "socket",
			appToken: required("SLACK_APP_TOKEN"),
			allow: {
				channels: list("HEYPI_SLACK_CHANNELS"),
				users: list("HEYPI_SLACK_USERS"),
				groups: list("HEYPI_SLACK_GROUPS"),
			},
			permissions: {
				approvers: { users: list("HEYPI_APPROVERS"), groups: list("HEYPI_APPROVER_GROUPS") },
			},
			trigger: "mention",
			reply: "thread",
			streaming: true,
		}),
		// Production HTTP mode:
		// slack({
		// 	botToken: required("SLACK_BOT_TOKEN"),
		// 	signingSecret: required("SLACK_SIGNING_SECRET"),
		// 	mode: "http",
		// 	allow: {
		// 		channels: list("HEYPI_SLACK_CHANNELS"),
		// 		users: list("HEYPI_SLACK_USERS"),
		// 		groups: list("HEYPI_SLACK_GROUPS"),
		// 	},
		// 	permissions: {
		// 		approvers: { users: list("HEYPI_APPROVERS"), groups: list("HEYPI_APPROVER_GROUPS") },
		// 	},
		// 	trigger: "mention",
		// 	reply: "thread",
		// 	streaming: true,
		// }),
	],
	agent: agentFrom("./agent", {
		id: "slack-devops",
		model: "openai/gpt-5-mini",
		context: [hostContext],
		tools: [...coreTools({ bash: true }), ...runbookTools, ...hostTools],
	}),
	approval: {
		expiresInMs: 10 * 60 * 1000,
	},
	jobs: jobChannel
		? [
				{
					id: "daily-health-check",
					schedule: { cron: "0 9 * * *", timezone: "UTC" },
					targets: { slack: { channels: [jobChannel] } },
					prompt: "Run a daily infrastructure health check and summarize anything that needs attention.",
					state: "active",
				},
				{
					id: "idle-incident-follow-up",
					kind: "heartbeat",
					everyMs: 6 * 60 * 60 * 1000,
					idleMs: 30 * 60 * 1000,
					scope: { slack: { channels: [jobChannel] } },
					prompt: "If an incident thread has gone quiet, ask whether follow-up is still needed.",
					state: "paused",
				},
			]
		: [],
	runtime: {
		root: workspace("./workspace"),
		scope: "channel",
	},
	memory: true,
});

await runHeypi(app);

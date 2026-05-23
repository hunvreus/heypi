import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { loadEnvFile } from "node:process";
import { agentFrom, consoleLogger, coreTools, createHeypi, slack, sqliteStore, workspace } from "@hunvreus/heypi";
import { createHostContext, createHostTools } from "./tools/host.js";
import { createRunbookTools } from "./tools/runbook.js";

loadEnv("examples/slack-devops/.env");
loadEnv(".env");

function loadEnv(path: string): void {
	if (existsSync(path)) loadEnvFile(path);
}

function required(name: string): string {
	const value = process.env[name];
	if (!value) throw new Error(`Missing env var: ${name}`);
	return value;
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

const hostTools = createHostTools({
	root: resolve("./examples/slack-devops/state"),
	commandPolicy,
	timeoutMs: 60_000,
});
const runbookTools = createRunbookTools({ root: resolve("./examples/slack-devops/agent/runbooks") });
const hostContext = createHostContext({ root: resolve("./examples/slack-devops/state") });

const app = createHeypi({
	store: sqliteStore({ path: resolve("./examples/slack-devops/heypi.db") }),
	logger: consoleLogger({ level: "debug", format: "pretty" }),
	adapters: [
		slack({
			botToken: required("SLACK_BOT_TOKEN"),
			mode: "socket",
			appToken: required("SLACK_APP_TOKEN"),
			allow: {
				teams: list("HEYPI_SLACK_TEAMS"),
				channels: list("HEYPI_SLACK_CHANNELS"),
				users: list("HEYPI_SLACK_USERS"),
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
		// 	port: Number(process.env.PORT ?? 3000),
		// 	path: "/slack/events",
		// 	allow: {
		// 		teams: list("HEYPI_SLACK_TEAMS"),
		// 		channels: list("HEYPI_SLACK_CHANNELS"),
		// 		users: list("HEYPI_SLACK_USERS"),
		// 	},
		// 	trigger: "mention",
		// 	reply: "thread",
		// 	streaming: true,
		// }),
	],
	agent: agentFrom("./examples/slack-devops/agent", {
		model: { provider: "openai", name: "gpt-5-mini", verbosity: "low" },
		context: [hostContext],
		tools: [...coreTools({ bash: true }), ...runbookTools, ...hostTools],
	}),
	approval: {
		approvers: list("HEYPI_APPROVERS"),
		expiresInMs: 10 * 60 * 1000,
	},
	runtime: {
		name: "just-bash",
		root: workspace("./examples/slack-devops/workspace"),
		maxConcurrent: 12,
		maxConcurrentPerChat: 1,
		timeoutMs: 120_000,
		justBash: {
			network: { dangerouslyAllowFullInternetAccess: true },
			python: false,
			javascript: false,
		},
	},
});

await app.start();

process.once("SIGTERM", () => void app.stop().finally(() => process.exit(0)));
process.once("SIGINT", () => void app.stop().finally(() => process.exit(0)));

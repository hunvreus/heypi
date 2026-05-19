import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { loadEnvFile } from "node:process";
import { agentFrom, consoleLogger, createHeypi, slack, sqliteStore, workspace } from "@hunvreus/heypi";
import { createHostTools } from "./host-tools.js";

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
	approve: [
		/\bsystemctl\s+(restart|stop|start|reload|enable|disable|mask|unmask)\b/i,
		/\bdocker\s+(restart|stop|rm|compose\s+up|compose\s+down|prune)\b/i,
		/\bapt(?:-get)?\s+(install|remove|purge|upgrade|dist-upgrade|autoremove)\b/i,
		/\byum\s+(install|remove|update|upgrade)\b/i,
	],
	block: [/\bcat\s+.*(?:\.env|id_rsa|id_ed25519)\b/i, /\bchmod\s+777\b/i],
};

const hostTools = createHostTools({
	root: resolve("./examples/slack-devops/state"),
	commandPolicy,
	timeoutMs: 60_000,
});

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
			progress: { reaction: "eyes", message: "Thinking..." },
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
	agent: agentFrom("./examples/slack-devops/agent", { model: "openai/gpt-5-mini", tools: hostTools }),
	approval: {
		approvers: list("HEYPI_APPROVERS"),
		expiresInMs: 10 * 60 * 1000,
		commands: commandPolicy,
	},
	runtime: {
		name: "just-bash",
		root: workspace("./examples/slack-devops/workspace"),
		maxConcurrent: 12,
		maxConcurrentPerChat: 1,
		timeoutMs: 120_000,
		justBash: {
			python: false,
			javascript: false,
		},
	},
});

await app.start();

process.once("SIGTERM", () => void app.stop().finally(() => process.exit(0)));
process.once("SIGINT", () => void app.stop().finally(() => process.exit(0)));

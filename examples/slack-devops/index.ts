import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { loadEnvFile } from "node:process";
import { agentFrom, consoleLogger, createHeypi, slack, sqliteStore, tool, workspace } from "@hunvreus/heypi";
import { Type } from "@sinclair/typebox";

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

const pageService = tool<{ service: string; reason: string }>({
	name: "page_service",
	description: "Record a demo service page request. Requires approval.",
	parameters: Type.Object({
		service: Type.String(),
		reason: Type.String(),
	}),
	confirm: (input) => ({ reason: `Page ${input.service}` }),
	execute: async ({ service, reason }) => `page recorded: service=${service} reason=${reason}`,
});

const app = createHeypi({
	store: sqliteStore({ path: resolve("./examples/slack-devops/heypi.db") }),
	logger: consoleLogger({ level: "debug", format: "pretty" }),
	adapters: [
		slack({
			botToken: required("SLACK_BOT_TOKEN"),
			signingSecret: required("SLACK_SIGNING_SECRET"),
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
		// 	reply: "thread",
		// }),
	],
	agent: agentFrom("./examples/slack-devops/agent", { model: "openai/gpt-5-mini", tools: [pageService] }),
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
			python: false,
			javascript: false,
		},
	},
});

await app.start();

process.once("SIGTERM", () => void app.stop().finally(() => process.exit(0)));
process.once("SIGINT", () => void app.stop().finally(() => process.exit(0)));

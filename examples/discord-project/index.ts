import { existsSync } from "node:fs";
import { loadEnvFile } from "node:process";
import { agentFrom, coreTools, createHeypi, discord, runHeypi, workspace } from "@hunvreus/heypi";
import { gondolinRuntime } from "@hunvreus/heypi-runtime-gondolin";

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

const app = createHeypi({
	state: { root: "./state" },
	http: {
		host: "127.0.0.1",
		port: 3000,
	},
	admin: true,
	scope: "channel",
	adapters: [
		discord({
			token: required("DISCORD_BOT_TOKEN"),
			allow: {
				channels: list("HEYPI_DISCORD_CHANNELS"),
				users: list("HEYPI_DISCORD_USERS"),
				groups: list("HEYPI_DISCORD_GROUPS"),
			},
			trigger: "mention",
			streaming: true,
		}),
	],
	agent: agentFrom("./agent", {
		model: "openai/gpt-5-mini",
		tools: coreTools({ bash: true }),
	}),
	approval: {
		approvers: { users: list("HEYPI_APPROVERS"), groups: list("HEYPI_APPROVER_GROUPS") },
		expiresInMs: 10 * 60 * 1000,
	},
	runtime: {
		root: workspace("./workspace"),
		scope: "channel",
		provider: gondolinRuntime({
			idleMs: 10 * 60 * 1000,
		}),
	},
	memory: true,
	skills: {
		enabled: true,
		scope: "channel",
	},
	secrets: {
		url: "http://127.0.0.1:3000/secret",
		serve: true,
	},
});

await runHeypi(app);

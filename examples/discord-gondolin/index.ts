import { createHeypi, discord, loadAgent, workspace } from "@hunvreus/heypi";
import { gondolinRuntime } from "@hunvreus/heypi-runtime-gondolin";

function list(name: string): string[] {
	return (process.env[name] ?? "")
		.split(",")
		.map((value) => value.trim())
		.filter(Boolean);
}

function optional(name: string): string | undefined {
	return process.env[name]?.trim() || undefined;
}

const secretUrl = optional("HEYPI_SECRET_URL");
const adapters = [
	discord({
		clientId: process.env.DISCORD_CLIENT_ID,
		allow: {
			channels: list("HEYPI_DISCORD_CHANNELS"),
			users: list("HEYPI_DISCORD_USERS"),
			groups: list("HEYPI_DISCORD_GROUPS"),
		},
		permissions: {
			approvers: {
				users: list("HEYPI_DISCORD_APPROVERS"),
				groups: list("HEYPI_DISCORD_APPROVER_GROUPS"),
			},
			admins: { users: list("HEYPI_DISCORD_ADMINS"), groups: list("HEYPI_DISCORD_ADMIN_GROUPS") },
		},
		trigger: "mention",
		streaming: true,
	}),
];

const app = createHeypi({
	state: { root: "./state" },
	http: {
		host: "127.0.0.1",
		port: Number(process.env.HEYPI_HTTP_PORT ?? 0),
	},
	scope: "channel",
	adapters,
	agent: loadAgent("./agent", {
		model: "openai/gpt-5-mini",
	}),
	approval: {
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
	secrets: secretUrl ? { url: secretUrl, serve: true } : true,
});

export default app;

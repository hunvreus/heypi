import {
	consoleLogger,
	createHeypi,
	loadAgent,
	slack,
	workspace,
} from "@hunvreus/heypi";
import { createHostContext } from "./agent/tools/host.js";

function optional(name: string): string | undefined {
	return process.env[name]?.trim() || undefined;
}

function list(name: string): string[] {
	return (process.env[name] ?? "")
		.split(",")
		.map((value) => value.trim())
		.filter(Boolean);
}

const stateRoot = "./state";
const hostContext = createHostContext({ root: stateRoot });
const log = consoleLogger({ level: "info", format: "pretty" });
const jobChannel = optional("HEYPI_SLACK_JOB_CHANNEL");
const secretUrl = optional("HEYPI_SECRET_URL");
const adapters = [
	slack({
		mode: "socket",
		allow: {
			channels: list("HEYPI_SLACK_CHANNELS"),
			users: list("HEYPI_SLACK_USERS"),
			groups: list("HEYPI_SLACK_GROUPS"),
		},
		permissions: {
			approvers: { users: list("HEYPI_SLACK_APPROVERS"), groups: list("HEYPI_SLACK_APPROVER_GROUPS") },
			admins: { users: list("HEYPI_SLACK_ADMINS"), groups: list("HEYPI_SLACK_ADMIN_GROUPS") },
		},
		trigger: "mention",
		response: { placement: "thread" },
		streaming: true,
	}),
];

if (!jobChannel) {
	log.warn("example.jobs_disabled", {
		missing: "HEYPI_SLACK_JOB_CHANNEL",
		reason: "Slack example jobs require an explicit target channel",
	});
}

const app = createHeypi({
	state: { root: stateRoot },
	logger: log,
	http: {
		host: "127.0.0.1",
		port: Number(process.env.HEYPI_HTTP_PORT ?? 0),
	},
	secrets: secretUrl ? { url: secretUrl, serve: true } : true,
	adapters,
	agent: loadAgent("./agent", {
		id: "slack-devops",
		model: "openai/gpt-5-mini",
		context: [hostContext],
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

// Production HTTP mode can replace the socket adapter above with slack({ mode: "http", signingSecret: ... }).

export default app;

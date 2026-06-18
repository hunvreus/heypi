import { existsSync } from "node:fs";
import { loadEnvFile } from "node:process";
import { pathToFileURL } from "node:url";
import {
	createHeypi,
	defaultTools,
	loadAgent,
	local,
	runHeypi,
	telegram,
	workspace,
} from "@hunvreus/heypi";

loadEnv(".env");

const isDev = process.env.HEYPI_DEV === "1";

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

const stateRoot = "./state";
const adapters = isDev
	? [local()]
	: [
			telegram({
				token: required("TELEGRAM_BOT_TOKEN"),
				allow: { chats: list("HEYPI_TELEGRAM_CHATS"), users: list("HEYPI_TELEGRAM_USERS") },
				trigger: "mention",
				streaming: true,
			}),
		];

const app = createHeypi({
	state: { root: stateRoot },
	adapters,
	agent: loadAgent("./agent", {
		model: "openai/gpt-5-mini",
		tools: defaultTools(),
	}),
	jobs: isDev
		? []
		: [
				{
					id: "daily-workout-checkin",
					kind: "heartbeat",
					everyMs: 24 * 60 * 60 * 1000,
					idleMs: 8 * 60 * 60 * 1000,
					scope: { telegram: {} },
					prompt:
						"Use the daily-checkin skill. Review the saved profile and decide whether to check in today based on the plan, rest days, and recent context.",
				},
			],
	runtime: { root: workspace("./workspace") },
});

export default app;

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
	await runHeypi(app);
}

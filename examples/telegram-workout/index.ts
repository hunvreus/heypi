import { createHeypi, loadAgent, telegram, workspace } from "@hunvreus/heypi";

function list(name: string): string[] {
	return (process.env[name] ?? "")
		.split(",")
		.map((value) => value.trim())
		.filter(Boolean);
}

const stateRoot = "./state";
const adapters = [
	telegram({
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
	}),
	jobs: process.env.TELEGRAM_BOT_TOKEN
		? [
				{
					id: "daily-workout-checkin",
					kind: "heartbeat",
					everyMs: 24 * 60 * 60 * 1000,
					idleMs: 8 * 60 * 60 * 1000,
					scope: { telegram: {} },
					prompt:
						"Use the daily-checkin skill. Review the saved profile and decide whether to check in today based on the plan, rest days, and recent context.",
				},
			]
		: [],
	runtime: { root: workspace("./workspace") },
});

export default app;

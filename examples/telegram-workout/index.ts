import { existsSync } from "node:fs";
import { appendFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { loadEnvFile } from "node:process";
import { Type } from "@sinclair/typebox";
import { agentFrom, consoleLogger, createHeypi, sqliteStore, telegram, tool, workspace } from "heypi";

loadEnv("examples/telegram-workout/.env");
loadEnv(".env");

function loadEnv(path: string): void {
	if (existsSync(path)) loadEnvFile(path);
}

function required(name: string): string {
	const value = process.env[name];
	if (!value) throw new Error(`Missing env var: ${name}`);
	return value;
}

const logPath = resolve("./examples/telegram-workout/memory/workouts.md");

const logWorkout = tool<{
	activity: string;
	date?: string;
	duration_min?: number;
	intensity?: string;
	notes?: string;
}>({
	name: "log_workout",
	description: "Append a completed workout entry to the local workout log.",
	parameters: Type.Object({
		activity: Type.String({ description: "Workout activity, e.g. run, lift, swim, mobility." }),
		date: Type.Optional(Type.String({ description: "Workout date if known, otherwise today." })),
		duration_min: Type.Optional(Type.Number({ description: "Duration in minutes if known." })),
		intensity: Type.Optional(Type.String({ description: "Short intensity note, e.g. easy, moderate, hard." })),
		notes: Type.Optional(Type.String({ description: "Short free-form notes." })),
	}),
	execute: async (input) => {
		const date = input.date ?? new Date().toISOString().slice(0, 10);
		const parts = [
			`- ${date}: ${input.activity}`,
			input.duration_min ? `${input.duration_min} min` : undefined,
			input.intensity ? `intensity=${input.intensity}` : undefined,
			input.notes,
		].filter(Boolean);
		await mkdir(dirname(logPath), { recursive: true });
		await appendFile(logPath, `${parts.join("; ")}\n`, "utf8");
		return `workout logged: ${parts.join("; ")}`;
	},
});

const app = createHeypi({
	store: sqliteStore({ path: resolve("./examples/telegram-workout/heypi.db") }),
	logger: consoleLogger({ level: "debug", format: "pretty" }),
	adapters: [telegram({ token: required("TELEGRAM_BOT_TOKEN"), progress: { message: "Thinking..." } })],
	agent: agentFrom("./examples/telegram-workout/agent", { model: "openai/gpt-5-mini", tools: [logWorkout] }),
	runtime: {
		name: "just-bash",
		root: workspace("./examples/telegram-workout/workspace"),
		maxConcurrent: 6,
		maxConcurrentPerChat: 1,
		timeoutMs: 60_000,
		justBash: { python: false, javascript: false },
	},
});

await app.start();

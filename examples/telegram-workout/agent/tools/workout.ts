import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { defineTool } from "@hunvreus/heypi/authoring";
import { Type } from "@sinclair/typebox";

const stateRoot = "./state";
const logPath = join(stateRoot, "memory/workouts.md");
const profilePath = join(stateRoot, "memory/profile.md");

const getProfile = defineTool({
	name: "get_profile",
	description: "Read the saved workout profile and plan.",
	input: Type.Object({}),
	run: async () => {
		try {
			return await readFile(profilePath, "utf8");
		} catch {
			return "No saved profile yet.";
		}
	},
});

const saveProfile = defineTool<{
	goal: string;
	plan: string;
	equipment?: string;
	age?: number;
	weight?: string;
	schedule?: string;
	preferences?: string;
	constraints?: string;
}>({
	name: "save_profile",
	description: "Save the user's workout profile, constraints, and current plan.",
	input: Type.Object({
		goal: Type.String({ description: "Primary training goal." }),
		plan: Type.String({ description: "Concise current workout plan." }),
		equipment: Type.Optional(Type.String({ description: "Available gym/home/outdoor equipment." })),
		age: Type.Optional(Type.Number({ description: "Age if shared." })),
		weight: Type.Optional(Type.String({ description: "Weight if shared, including unit if known." })),
		schedule: Type.Optional(Type.String({ description: "Training days, rest days, and usual session length." })),
		preferences: Type.Optional(Type.String({ description: "Workout preferences and dislikes." })),
		constraints: Type.Optional(Type.String({ description: "Injuries, time, travel, sleep, or other constraints." })),
	}),
	run: async (input) => {
		await mkdir(dirname(profilePath), { recursive: true });
		const body = [
			`# Workout Profile`,
			``,
			`Updated: ${new Date().toISOString()}`,
			`Goal: ${input.goal}`,
			input.age ? `Age: ${input.age}` : undefined,
			input.weight ? `Weight: ${input.weight}` : undefined,
			input.equipment ? `Equipment: ${input.equipment}` : undefined,
			input.schedule ? `Schedule: ${input.schedule}` : undefined,
			input.preferences ? `Preferences: ${input.preferences}` : undefined,
			input.constraints ? `Constraints: ${input.constraints}` : undefined,
			``,
			`## Plan`,
			input.plan,
			``,
		].filter((line) => line !== undefined);
		await writeFile(profilePath, `${body.join("\n")}\n`, "utf8");
		return "profile saved";
	},
});

const logWorkout = defineTool<{
	activity: string;
	date?: string;
	duration_min?: number;
	intensity?: string;
	notes?: string;
}>({
	name: "log_workout",
	description: "Append a completed workout entry to the local workout log.",
	input: Type.Object({
		activity: Type.String({ description: "Workout activity, e.g. run, lift, swim, mobility." }),
		date: Type.Optional(Type.String({ description: "Workout date if known, otherwise today." })),
		duration_min: Type.Optional(Type.Number({ description: "Duration in minutes if known." })),
		intensity: Type.Optional(Type.String({ description: "Short intensity note, e.g. easy, moderate, hard." })),
		notes: Type.Optional(Type.String({ description: "Short free-form notes." })),
	}),
	run: async (input) => {
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

export default [getProfile, saveProfile, logWorkout];

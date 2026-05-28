import { existsSync } from "node:fs";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { loadEnvFile } from "node:process";
import { agentFrom, consoleLogger, coreTools, createHeypi, discord, runHeypi, tool, workspace } from "@hunvreus/heypi";
import { Type } from "@sinclair/typebox";

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

const stateRoot = "./state";
const notesPath = join(stateRoot, "project-notes.md");

const projectNote = tool<{ note: string; project?: string }>({
	name: "project_note",
	description: "Append a short project note to the local project log.",
	parameters: Type.Object({
		note: Type.String({ description: "Concise note to save." }),
		project: Type.Optional(Type.String({ description: "Project or workstream name." })),
	}),
	execute: async ({ note, project }) => {
		await mkdir(dirname(notesPath), { recursive: true });
		const prefix = project ? `[${project}] ` : "";
		await appendFile(notesPath, `- ${new Date().toISOString()} ${prefix}${note}\n`, "utf8");
		return "project note saved";
	},
});

const setProjectStatus = tool<{ project: string; status: string; reason: string }>({
	name: "set_project_status",
	description: "Append an approved project status update.",
	parameters: Type.Object({
		project: Type.String({ description: "Project or workstream name." }),
		status: Type.String({ description: "New status, e.g. on track, blocked, at risk, shipped." }),
		reason: Type.String({ description: "Short reason for the status change." }),
	}),
	confirm: ({ project, status, reason }) => ({
		message: "Update project status.",
		details: [
			{ label: "Project", value: String(project) },
			{ label: "Status", value: String(status) },
			{ label: "Reason", value: String(reason) },
		],
	}),
	execute: async ({ project, status, reason }) => {
		await mkdir(dirname(notesPath), { recursive: true });
		await appendFile(notesPath, `- ${new Date().toISOString()} [${project}] status=${status}; ${reason}\n`, "utf8");
		return `status updated: ${project} is ${status}`;
	},
});

const readProjectNotes = tool({
	name: "read_project_notes",
	description: "Read saved project notes.",
	parameters: Type.Object({}),
	execute: async () => {
		try {
			return await readFile(notesPath, "utf8");
		} catch {
			return "No project notes yet.";
		}
	},
});

const app = createHeypi({
	state: { root: stateRoot },
	logger: consoleLogger({ level: "debug", format: "pretty" }),
	adapters: [
		discord({
			token: required("DISCORD_BOT_TOKEN"),
			allow: {
				guilds: list("HEYPI_DISCORD_GUILDS"),
				channels: list("HEYPI_DISCORD_CHANNELS"),
				users: list("HEYPI_DISCORD_USERS"),
			},
			trigger: "mention",
			streaming: true,
		}),
	],
	agent: agentFrom("./agent", {
		model: { provider: "openai", name: "gpt-5-mini", verbosity: "low" },
		tools: [...coreTools(), projectNote, setProjectStatus, readProjectNotes],
	}),
	approval: {
		approvers: list("HEYPI_APPROVERS"),
		expiresInMs: 10 * 60 * 1000,
	},
	runtime: {
		name: "just-bash",
		root: workspace("./workspace"),
		maxConcurrentPerChat: 1,
		timeoutMs: 60_000,
		justBash: { python: false, javascript: false },
	},
});

await runHeypi(app);

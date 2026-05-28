import { existsSync } from "node:fs";
import { appendFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { loadEnvFile } from "node:process";
import { agentFrom, consoleLogger, coreTools, createHeypi, runHeypi, tool, webhook, workspace } from "@hunvreus/heypi";
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

const stateRoot = "./state";
const notesPath = join(stateRoot, "notes.md");

const saveNote = tool<{ note: string; topic?: string }>({
	name: "save_note",
	description: "Append a short note to local Markdown.",
	parameters: Type.Object({
		note: Type.String({ description: "Concise note to save." }),
		topic: Type.Optional(Type.String({ description: "Optional topic label." })),
	}),
	execute: async ({ note, topic }) => {
		await mkdir(dirname(notesPath), { recursive: true });
		const prefix = topic ? `[${topic}] ` : "";
		await appendFile(notesPath, `- ${new Date().toISOString()} ${prefix}${note}\n`, "utf8");
		return "note saved";
	},
});

const app = createHeypi({
	state: { root: stateRoot },
	logger: consoleLogger({ level: "debug", format: "pretty" }),
	http: {
		host: "127.0.0.1",
		port: Number(process.env.HEYPI_WEBHOOK_PORT ?? 3000),
	},
	adapters: [
		webhook({
			name: "notes",
			secret: required("HEYPI_WEBHOOK_SECRET"),
		}),
	],
	agent: agentFrom("./agent", {
		model: { provider: "openai", name: "gpt-5-mini", verbosity: "low" },
		tools: [...coreTools({ bash: false, write: false, edit: false }), saveNote],
	}),
	runtime: {
		name: "just-bash",
		root: workspace("./workspace"),
		maxConcurrentPerChat: 1,
		timeoutMs: 60_000,
		justBash: { python: false, javascript: false },
	},
});

await runHeypi(app);

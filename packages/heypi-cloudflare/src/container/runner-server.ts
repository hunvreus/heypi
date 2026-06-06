import { existsSync, mkdirSync } from "node:fs";
import { createServer } from "node:http";
import { resolve } from "node:path";
import { loadEnvFile } from "node:process";
import { agentFrom, coreTools, createAgentRunner, sqliteStore } from "@hunvreus/heypi";
import type { SessionEntry } from "@hunvreus/heypi/runtime";

// The "container" side of the Durable-Object design: a plain Node service that runs the real Pi
// agent. The Worker/DO owns session state and calls this over HTTP with the transcript; this
// service rehydrates, runs one turn, and returns the updated transcript + reply. Pi loads its Node
// dependencies fine here (unlike the Workers isolate). Locally it's a process; in production it's a
// Cloudflare Container.

const envPath = process.env.RUNNER_ENV ?? ".env";
if (existsSync(envPath)) loadEnvFile(envPath);

const port = Number(process.env.RUNNER_PORT ?? 8788);
const model = process.env.HEYPI_MODEL ?? "openai/gpt-5-mini";
const agentDir = resolve(process.env.AGENT_DIR ?? "./agent");
const stateDir = resolve(process.env.RUNNER_STATE ?? "./.runner-state");
const workspaceDir = resolve(agentDir, "..", "workspace");
for (const dir of [stateDir, workspaceDir]) if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

const store = sqliteStore({ path: resolve(stateDir, "runner.db") });
await store.setup();

const runner = createAgentRunner({
	agent: agentFrom(agentDir, { model, tools: coreTools({ bash: true }) }),
	store,
	runtime: { name: "just-bash", root: workspaceDir },
});

type RunBody = { sessionId?: string; text?: string; entries?: SessionEntry[]; actor?: string; channel?: string };

const server = createServer((req, res) => {
	const json = (status: number, body: unknown) => {
		res.writeHead(status, { "content-type": "application/json" });
		res.end(JSON.stringify(body));
	};

	if (req.method === "GET" && req.url === "/health") return json(200, { ok: true, model });
	if (req.method !== "POST" || req.url !== "/run") return json(404, { error: "not found" });

	let raw = "";
	req.on("data", (chunk) => {
		raw += chunk;
	});
	req.on("end", async () => {
		let body: RunBody;
		try {
			body = JSON.parse(raw) as RunBody;
		} catch {
			return json(400, { error: "invalid json" });
		}
		if (!body.sessionId || typeof body.text !== "string") {
			return json(400, { error: "sessionId and text are required" });
		}
		try {
			const result = await runner.run({
				sessionId: body.sessionId,
				text: body.text,
				entries: body.entries ?? [],
				actor: body.actor,
				channel: body.channel,
			});
			return json(200, result);
		} catch (error) {
			return json(500, { error: error instanceof Error ? error.message : String(error) });
		}
	});
});

// Bind 0.0.0.0 so the service is reachable from outside the container (required by Modal/Containers).
server.listen(port, "0.0.0.0", () => console.log(`[runner] listening on http://0.0.0.0:${port} (model=${model})`));

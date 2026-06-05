import { captureSession, openSessionFromEntries } from "@hunvreus/heypi/runtime";
import type { RunnerInput, RunnerOutput } from "./runner.js";

const AGENT_CWD = "/agent";

/**
 * The container-side agent turn: rehydrate Pi in memory from the supplied transcript, produce a
 * reply, and return the updated transcript. This runs in a real Node container (not the Worker
 * isolate) because Pi imports Node builtins at load. The Durable Object ships {entries, text}
 * here over RPC/HTTP and persists the returned entries — it never imports Pi itself.
 *
 * The reply step is a placeholder that echoes; Phase 2B replaces it with PiAgent.ask() wired to
 * the same in-memory session. Implements the SessionRunner contract so it can drop into the DO's
 * runner seam via a thin container transport.
 */
export async function runPiTurn(input: RunnerInput): Promise<RunnerOutput> {
	const session = openSessionFromEntries({ sessionId: input.sessionId, cwd: AGENT_CWD, entries: input.entries });
	const append = (role: "user" | "assistant", text: string) =>
		session.appendMessage({ role, content: [{ type: "text", text }] } as Parameters<typeof session.appendMessage>[0]);

	append("user", input.text);
	const reply = `ack: ${input.text}`;
	append("assistant", reply);

	return { entries: captureSession(session).entries, reply };
}

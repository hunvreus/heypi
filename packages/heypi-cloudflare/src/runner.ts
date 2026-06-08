import type { SessionEntry } from "@hunvreus/heypi/runtime";

export type RunnerInput = { sessionId: string; entries: SessionEntry[]; text: string };
export type RunnerOutput = { entries: SessionEntry[]; reply: string };

/**
 * Runs one agent turn given the current transcript, returning the new transcript and reply.
 *
 * The Durable Object depends on this seam rather than on Pi directly. That separation is not
 * cosmetic: Pi imports Node builtins via bare specifiers (`import { homedir } from "os"`, plus
 * `fs`/`path`/`url`) at module load, which do not resolve in the Workers isolate even with
 * nodejs_compat. So the production runner delegates execution to a container (real Node), where
 * heypi's in-memory session rehydration runs unchanged; the container-side implementation lives
 * in turn.ts (`runPiTurn`) and is exercised under Node. The Worker/DO bundle stays Pi-free.
 */
export interface SessionRunner {
	run(input: RunnerInput): Promise<RunnerOutput>;
}

/**
 * A dependency-free runner used as the DO default and in tests. It appends a user/assistant
 * message pair shaped like Pi session entries, without importing Pi — enough to exercise the DO
 * lock, DO-SQLite persistence, and Worker routing inside workerd. Swap for a ContainerRunner to
 * run the real agent.
 */
export class EchoRunner implements SessionRunner {
	async run(input: RunnerInput): Promise<RunnerOutput> {
		const reply = `ack: ${input.text}`;
		let parentId = lastEntryId(input.entries);
		const next = [...input.entries];
		for (const [role, text] of [
			["user", input.text],
			["assistant", reply],
		] as const) {
			const entry = messageEntry(role, text, parentId);
			next.push(entry);
			parentId = entry.id;
		}
		return { entries: next, reply };
	}
}

function lastEntryId(entries: SessionEntry[]): string | null {
	return entries.length ? entries[entries.length - 1].id : null;
}

function messageEntry(role: "user" | "assistant", text: string, parentId: string | null): SessionEntry {
	return {
		type: "message",
		id: crypto.randomUUID(),
		parentId,
		timestamp: new Date().toISOString(),
		message: { role, content: [{ type: "text", text }] },
	} as SessionEntry;
}

import {
	CURRENT_SESSION_VERSION,
	type SessionEntry,
	type SessionHeader,
	SessionManager,
} from "@earendil-works/pi-coding-agent";

/**
 * Rebuilds a Pi session from a previously captured entry list, entirely in memory.
 *
 * This is the keystone for running heypi without a writable filesystem: a turn becomes
 * "load entries from a SessionStore -> rehydrate -> run -> capture entries -> save", with
 * no JSONL file on disk. Pi already ships everything required for this — inMemory() runs
 * with persistence off, and the entry tree is an ordinary array — but it does not yet expose
 * a public constructor from entries. Until an upstream `SessionManager.fromEntries()` lands,
 * we inject the captured tree and rebuild the index here. This function is the ONLY place
 * that touches Pi internals; swapping it for the official API later is a one-line change.
 */
type SessionInternals = {
	fileEntries: (SessionHeader | SessionEntry)[];
	sessionId: string;
	_buildIndex(): void;
};

export type SessionSnapshot = {
	sessionId: string;
	entries: SessionEntry[];
};

/** Captures the entry tree of a live session for durable storage (header is reconstructed on load). */
export function captureSession(session: SessionManager): SessionSnapshot {
	return { sessionId: session.getSessionId(), entries: session.getEntries() };
}

/** Reconstructs a live, in-memory session from a captured snapshot. No filesystem access. */
export function openSessionFromEntries(input: {
	sessionId: string;
	cwd: string;
	entries: SessionEntry[];
}): SessionManager {
	const session = SessionManager.inMemory(input.cwd);
	const header: SessionHeader = {
		type: "session",
		version: CURRENT_SESSION_VERSION,
		id: input.sessionId,
		timestamp: new Date().toISOString(),
		cwd: input.cwd,
	};
	const internals = session as unknown as SessionInternals;
	internals.fileEntries = [header, ...input.entries];
	internals.sessionId = input.sessionId;
	internals._buildIndex();
	return session;
}

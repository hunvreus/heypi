import { resolve } from "node:path";
import { openDb } from "./db.js";
import { migrate } from "./migrate.js";
import { ApprovalRepo } from "./repo-approval.js";
import { CallRepo } from "./repo-call.js";
import { LockRepo } from "./repo-lock.js";
import { MessageRepo } from "./repo-message.js";
import { ThreadRepo } from "./repo-thread.js";
import { TurnRepo } from "./repo-turn.js";
import { SessionStore } from "./session-store.js";
import type { Store } from "./types.js";

/** Creates the built-in SQLite file store. */
export function sqliteStore(input: { path: string }): Store {
	const db = openDb({ url: `file:${resolve(input.path)}` });
	const messages = new MessageRepo(db);
	return {
		threads: new ThreadRepo(db),
		messages,
		sessions: new SessionStore(messages),
		turns: new TurnRepo(db),
		calls: new CallRepo(db),
		approvals: new ApprovalRepo(db),
		locks: new LockRepo(db),
		setup: () => migrate(db),
	};
}

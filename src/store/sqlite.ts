import { resolve } from "node:path";
import { openDb } from "./db.js";
import { migrate } from "./migrate.js";
import { ApprovalRepo } from "./repo-approval.js";
import { CallRepo } from "./repo-call.js";
import { JobRepo, JobRunRepo } from "./repo-job.js";
import { LockRepo } from "./repo-lock.js";
import { MessageRepo } from "./repo-message.js";
import { ThreadRepo } from "./repo-thread.js";
import { TurnRepo } from "./repo-turn.js";
import type { Store } from "./types.js";

/** Creates the built-in SQLite file store. */
export function sqliteStore(input: { path: string }): Store {
	const db = openDb({ url: `file:${resolve(input.path)}` });
	return sqliteStoreFromDb(db, false);
}

function sqliteStoreFromDb(db: ReturnType<typeof openDb>, nested: boolean): Store {
	const messages = new MessageRepo(db);
	return {
		threads: new ThreadRepo(db),
		messages,
		turns: new TurnRepo(db),
		calls: new CallRepo(db),
		approvals: new ApprovalRepo(db),
		jobs: new JobRepo(db),
		jobRuns: new JobRunRepo(db),
		locks: new LockRepo(db),
		setup: () => migrate(db),
		transaction: (fn) => {
			if (nested) throw new Error("nested store transactions are not supported");
			// Drizzle transaction handles expose the query surface we use, but not the full client type.
			return db.transaction(async (tx) => fn(sqliteStoreFromDb(tx as unknown as ReturnType<typeof openDb>, true)));
		},
	};
}

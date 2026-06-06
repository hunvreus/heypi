import { DurableObject } from "cloudflare:workers";
import { ContainerRunner, EchoRunner, type SessionRunner } from "./runner.js";
import { DurableSessions } from "./sessions.js";

export type ThreadAgentEnv = {
	/** Pi runner service base URL. When set, real agent turns run there; otherwise EchoRunner replies. */
	RUNNER_URL?: string;
};

export type Inbound = { sessionId: string; text: string };
export type TurnResult = { reply: string; entries: number };

/**
 * One Durable Object instance per conversation thread.
 *
 * Because a Durable Object processes requests single-threaded, this object IS the per-thread
 * lock — overlapping turns for the same thread are serialized by the platform, so heypi's
 * hand-rolled lock table is unnecessary here. It owns the thread's transcript via DurableSessions
 * (its embedded SQLite) and delegates the actual agent turn to a SessionRunner. The runner is a
 * seam because Pi cannot run in this isolate (see runner.ts); production swaps EchoRunner for a
 * container-backed runner. Scheduler heartbeats will hang off ctx.storage alarms in a later phase.
 */
export class ThreadAgent extends DurableObject<ThreadAgentEnv> {
	private readonly sessions: DurableSessions;
	private readonly runner: SessionRunner;

	constructor(ctx: DurableObjectState, env: ThreadAgentEnv) {
		super(ctx, env);
		this.sessions = new DurableSessions(ctx.storage.sql);
		this.runner = env.RUNNER_URL ? new ContainerRunner(env.RUNNER_URL) : new EchoRunner();
	}

	/** Processes one inbound message for this thread and returns the reply. Callable via DO RPC. */
	async turn(inbound: Inbound): Promise<TurnResult> {
		const entries = (await this.sessions.load(inbound.sessionId)) ?? [];
		const result = await this.runner.run({ sessionId: inbound.sessionId, entries, text: inbound.text });
		await this.sessions.save(inbound.sessionId, result.entries);
		return { reply: result.reply, entries: result.entries.length };
	}
}

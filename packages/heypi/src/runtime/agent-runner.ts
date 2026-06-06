import { resolve } from "node:path";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { AgentConfig, RuntimeConfig } from "../config.js";
import { CallRunner } from "../core/calls.js";
import { logger as defaultLogger, type Logger } from "../core/log.js";
import type { Sessions, Store } from "../store/types.js";
import { createRuntime } from "./index.js";
import { PiAgent } from "./pi-agent.js";
import { Queue } from "./queue.js";

export type AgentRunInput = {
	sessionId: string;
	text: string;
	entries: SessionEntry[];
	actor?: string;
	channel?: string;
};

export type AgentRunResult = { reply: string; entries: SessionEntry[] };

export type AgentRunnerConfig = {
	/** Agent identity, model, directory, and tools. */
	agent: AgentConfig;
	/** Backing store for messages/calls/approvals. The session transcript is supplied per call. */
	store: Store;
	/** Runtime for tools. Defaults to the built-in just-bash in a workspace beside the agent directory. */
	runtime?: RuntimeConfig;
	logger?: Logger;
};

export type AgentRunner = {
	run(input: AgentRunInput): Promise<AgentRunResult>;
};

/** A Sessions store scoped to a single run: load returns the supplied entries, save captures the result. */
class RequestSessions implements Sessions {
	captured: SessionEntry[];
	constructor(private readonly entries: SessionEntry[]) {
		this.captured = entries;
	}
	async load(): Promise<SessionEntry[] | null> {
		return this.entries;
	}
	async save(_sessionId: string, entries: SessionEntry[]): Promise<void> {
		this.captured = entries;
	}
}

/**
 * Builds a headless agent runner: given a transcript and a message, runs one real PiAgent turn and
 * returns the updated transcript plus the reply. The transcript is passed in and out (never read
 * from disk), so a serverless host can own session state elsewhere (e.g. a Durable Object) while
 * this runner executes the agent in a Node environment where Pi can load its Node dependencies.
 */
export function createAgentRunner(config: AgentRunnerConfig): AgentRunner {
	const log = config.logger ?? defaultLogger;
	const runtimeConfig: RuntimeConfig = config.runtime ?? {
		name: "just-bash",
		root: resolve(config.agent.directory, "..", "workspace"),
	};
	const runtime = createRuntime({ ...runtimeConfig, app: process.cwd(), agent: config.agent.directory });
	const callRunner = new CallRunner(
		config.store.calls,
		config.store.approvals,
		new Queue({}),
		runtime,
		undefined,
		log,
		config.store.transaction,
	);

	return {
		async run(input) {
			const sessions = new RequestSessions(input.entries);
			const agent = new PiAgent({
				agent: config.agent,
				callRunner,
				runtime,
				messages: config.store.messages,
				sessions,
				logger: log,
			});
			const reply = await agent.ask({
				threadId: input.sessionId,
				sessionId: input.sessionId,
				sessionPath: `${input.sessionId}.jsonl`,
				provider: "runner",
				channel: input.channel ?? input.sessionId,
				actor: input.actor ?? "user",
				text: input.text,
			});
			return { reply: reply.text, entries: sessions.captured };
		},
	};
}

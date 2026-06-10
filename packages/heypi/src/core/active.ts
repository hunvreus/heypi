import type { Attachment } from "../io/attachments.js";
import type { AppMessages } from "./messages.js";

export type CancelResult = "cancelled" | "not_found" | "unauthorized";

export type ActiveRunInfo = {
	actor?: string;
	threadId?: string;
	cancelledBy?: string;
};

type LiveSession = {
	steer(text: string, attachments?: Attachment[]): Promise<void>;
	followUp(text: string, attachments?: Attachment[]): Promise<void>;
};

type PendingLiveMessage = {
	kind: "steer" | "followUp";
	text: string;
	attachments?: Attachment[];
};

type ActiveRun = {
	controller: AbortController;
	aliases: string[];
	done: Promise<void>;
	resolve: () => void;
	session?: LiveSession;
	pending: PendingLiveMessage[];
	additions: number;
	accepting: boolean;
	info: ActiveRunInfo;
};

export class ActiveRuns {
	private readonly runs = new Map<string, ActiveRun>();
	private readonly active = new Set<ActiveRun>();

	start(
		aliases: string[],
		info: ActiveRunInfo = {},
	): {
		signal: AbortSignal;
		stop: () => void;
		attach: (session: LiveSession) => void;
		detach: () => void;
		additions: () => number;
		cancelledBy: () => string | undefined;
	} {
		const controller = new AbortController();
		const unique = [...new Set(aliases.filter(Boolean))];
		let resolveDone!: () => void;
		const done = new Promise<void>((resolve) => {
			resolveDone = resolve;
		});
		const run: ActiveRun = {
			controller,
			aliases: unique,
			done,
			resolve: resolveDone,
			pending: [],
			additions: 0,
			accepting: true,
			info,
		};
		this.active.add(run);
		for (const alias of unique) this.runs.set(alias, run);
		return {
			signal: controller.signal,
			stop: () => this.stop(run),
			attach: (session) => {
				run.accepting = true;
				run.session = session;
				void this.drainLive(run);
			},
			detach: () => {
				run.accepting = false;
				run.session = undefined;
				run.pending = [];
			},
			additions: () => run.additions,
			cancelledBy: () => run.info.cancelledBy,
		};
	}

	async enqueue(
		id: string,
		kind: "steer" | "followUp",
		text: string,
		attachments?: Attachment[],
	): Promise<"queued" | "not_found"> {
		const run = this.runs.get(id);
		if (!run) return "not_found";
		if (!run.accepting) return "not_found";
		run.additions++;
		run.pending.push({ kind, text, attachments });
		await this.drainLive(run);
		return "queued";
	}

	cancel(id: string, actor?: string): CancelResult {
		const run = this.runs.get(id);
		if (!run) return "not_found";
		run.info.cancelledBy = actor;
		run.controller.abort();
		this.stop(run);
		return "cancelled";
	}

	has(id: string): boolean {
		return this.runs.has(id);
	}

	info(id: string): ActiveRunInfo | undefined {
		return this.runs.get(id)?.info;
	}

	abortAll(): number {
		const runs = [...this.active];
		for (const run of runs) run.controller.abort();
		return runs.length;
	}

	async drain(timeoutMs: number): Promise<boolean> {
		if (this.active.size === 0) return true;
		return await new Promise((resolve) => {
			let done = false;
			const finish = (value: boolean) => {
				if (done) return;
				done = true;
				clearTimeout(timer);
				resolve(value);
			};
			const timer = setTimeout(() => finish(this.active.size === 0), timeoutMs);
			void Promise.all([...this.active].map((run) => run.done)).then(() => finish(true));
		});
	}

	count(): number {
		return this.active.size;
	}

	private stop(run: ActiveRun): void {
		if (!this.active.delete(run)) return;
		for (const alias of run.aliases) {
			if (this.runs.get(alias) === run) this.runs.delete(alias);
		}
		run.resolve();
	}

	private async drainLive(run: ActiveRun): Promise<void> {
		if (!run.session) return;
		while (run.pending.length) {
			const item = run.pending.shift();
			if (!item) return;
			if (item.kind === "steer") await run.session.steer(item.text, item.attachments);
			else await run.session.followUp(item.text, item.attachments);
		}
	}
}

export function cancelReply(
	result: CancelResult,
	messages: AppMessages,
): { text: string; private: true; silent?: true } {
	if (result === "cancelled") return { text: "", private: true, silent: true };
	if (result === "unauthorized") return { text: messages.cancelUnauthorized, private: true };
	return { text: messages.cancelNotFound, private: true };
}

export function isAbortError(error: unknown): boolean {
	if (!(error instanceof Error)) return false;
	return error.name === "AbortError";
}

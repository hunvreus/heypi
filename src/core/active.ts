export type CancelResult = "cancelled" | "not_found";

type ActiveRun = {
	controller: AbortController;
	aliases: string[];
};

export class ActiveRuns {
	private readonly runs = new Map<string, ActiveRun>();

	start(aliases: string[]): { signal: AbortSignal; stop: () => void } {
		const controller = new AbortController();
		const unique = [...new Set(aliases.filter(Boolean))];
		const run = { controller, aliases: unique };
		for (const alias of unique) this.runs.set(alias, run);
		return {
			signal: controller.signal,
			stop: () => {
				for (const alias of unique) {
					if (this.runs.get(alias) === run) this.runs.delete(alias);
				}
			},
		};
	}

	cancel(id: string): CancelResult {
		const run = this.runs.get(id);
		if (!run) return "not_found";
		run.controller.abort();
		for (const alias of run.aliases) {
			if (this.runs.get(alias) === run) this.runs.delete(alias);
		}
		return "cancelled";
	}
}

export function cancelReply(result: CancelResult): { text: string; private: true } {
	if (result === "cancelled") return { text: "cancelled", private: true };
	return { text: "not found or already completed", private: true };
}

export function isAbortError(error: unknown): boolean {
	if (!(error instanceof Error)) return false;
	const text = `${error.name}\n${error.message}`.toLowerCase();
	return text.includes("abort") || text.includes("cancel");
}

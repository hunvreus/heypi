type Job<T> = {
	chat: string;
	enqueuedAt: number;
	execute: () => Promise<T>;
	resolve: (value: { result: T; waitMs: number }) => void;
	reject: (error: Error) => void;
	signal?: AbortSignal;
	onAbort?: () => void;
};

export class Queue {
	private readonly pending: Job<unknown>[] = [];
	private readonly chatActive = new Map<string, number>();
	private active = 0;

	constructor(private readonly options: { maxConcurrent?: number; maxPerChat?: number }) {}

	submit<T>(chat: string, execute: () => Promise<T>, signal?: AbortSignal): Promise<{ result: T; waitMs: number }> {
		return new Promise((resolve, reject) => {
			if (signal?.aborted) {
				reject(new Error("cancelled"));
				return;
			}
			const job = { chat, execute, enqueuedAt: Date.now(), resolve, reject, signal } as Job<unknown>;
			if (signal) {
				job.onAbort = () => {
					const index = this.pending.indexOf(job);
					if (index >= 0) {
						this.pending.splice(index, 1);
						job.reject(new Error("cancelled"));
					}
				};
				signal.addEventListener("abort", job.onAbort, { once: true });
			}
			this.pending.push(job);
			this.drain();
		});
	}

	private drain(): void {
		while (this.active < (this.options.maxConcurrent ?? 12)) {
			const index = this.pick();
			if (index < 0) return;
			const job = this.pending.splice(index, 1)[0];
			void this.work(job);
		}
	}

	private pick(): number {
		for (let i = 0; i < this.pending.length; i++) {
			const job = this.pending[i];
			if (job.signal?.aborted) {
				this.pending.splice(i, 1);
				if (job.onAbort) job.signal.removeEventListener("abort", job.onAbort);
				job.reject(new Error("cancelled"));
				i--;
				continue;
			}
			if ((this.chatActive.get(job.chat) ?? 0) < (this.options.maxPerChat ?? 1)) return i;
		}
		return -1;
	}

	private async work(job: Job<unknown>): Promise<void> {
		if (job.onAbort && job.signal) job.signal.removeEventListener("abort", job.onAbort);
		this.active += 1;
		this.chatActive.set(job.chat, (this.chatActive.get(job.chat) ?? 0) + 1);
		try {
			const result = await job.execute();
			job.resolve({ result, waitMs: Date.now() - job.enqueuedAt });
		} catch (error) {
			job.reject(error instanceof Error ? error : new Error(String(error)));
		} finally {
			this.active -= 1;
			const next = (this.chatActive.get(job.chat) ?? 1) - 1;
			if (next <= 0) this.chatActive.delete(job.chat);
			else this.chatActive.set(job.chat, next);
			this.drain();
		}
	}
}

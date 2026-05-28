import { message as errorMessage, type Logger } from "../core/log.js";

export type DeliveryConfig = {
	intervalMs?: number;
	retries?: number;
	baseMs?: number;
};

type DeliveryRetry = "idempotent" | "send";
export type DeliveryContext = Record<string, unknown> & { retry?: DeliveryRetry };

/** Serializes provider delivery calls and retries transient failures. */
export class DeliveryQueue {
	private readonly intervalMs: number;
	private readonly retries: number;
	private readonly baseMs: number;
	private queue: Promise<void> = Promise.resolve();
	private last = 0;

	constructor(
		config: DeliveryConfig | false | undefined = {},
		private readonly logger?: Logger,
	) {
		const enabled = config !== false;
		this.intervalMs = enabled ? (config.intervalMs ?? 350) : 0;
		this.retries = enabled ? (config.retries ?? 2) : 0;
		this.baseMs = enabled ? (config.baseMs ?? 500) : 0;
	}

	async run<T>(fn: () => Promise<T>, context?: DeliveryContext): Promise<T> {
		const task = this.queue.then(async () => {
			await this.wait();
			try {
				const { retry, ...logContext } = context ?? {};
				return await withRetry(fn, {
					retries: this.retries,
					baseMs: this.baseMs,
					logger: this.logger,
					context: logContext,
					mode: retry,
				});
			} finally {
				this.last = Date.now();
			}
		});
		this.queue = task.then(
			() => undefined,
			() => undefined,
		);
		return task;
	}

	private async wait(): Promise<void> {
		const wait = this.intervalMs - (Date.now() - this.last);
		if (wait > 0) await sleep(wait);
	}
}

async function withRetry<T>(
	fn: () => Promise<T>,
	input: {
		retries?: number;
		baseMs?: number;
		logger?: Logger;
		context?: Record<string, unknown>;
		mode?: DeliveryRetry;
	} = {},
): Promise<T> {
	const retries = input.retries ?? 2;
	const baseMs = input.baseMs ?? 500;
	for (let attempt = 0; ; attempt++) {
		try {
			return await fn();
		} catch (error) {
			if (attempt >= retries || !retryable(error, input.mode ?? "idempotent")) throw error;
			const wait = retryAfterMs(error) ?? baseMs * 2 ** attempt;
			input.logger?.warn("delivery.retry", {
				...(input.context ?? {}),
				attempt: attempt + 1,
				retryMs: wait,
				error: errorMessage(error),
			});
			await sleep(wait);
		}
	}
}

function retryable(error: unknown, mode: DeliveryRetry): boolean {
	const text = errorMessage(error).toLowerCase();
	if (text.includes("429") || text.includes("rate") || text.includes("retry after")) return true;
	if (mode === "send") return false;
	return (
		text.includes("timeout") || text.includes("econnreset") || text.includes("temporarily") || /\b5\d\d\b/.test(text)
	);
}

function retryAfterMs(error: unknown): number | undefined {
	const value = (error as { retryAfter?: unknown })?.retryAfter;
	if (typeof value === "number" && Number.isFinite(value)) return Math.max(0, value * 1000);
	const match = errorMessage(error).match(/retry[_ -]after[:=]?\s*(\d+)/i);
	return match ? Number(match[1]) * 1000 : undefined;
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

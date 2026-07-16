export type RetryConfig = {
	attempts?: number;
	minDelayMs?: number;
	maxDelayMs?: number;
};

export type ResolvedRetry = {
	attempts: number;
	minDelayMs: number;
	maxDelayMs: number;
};

/** Normalize bounded retry settings for idempotent transport operations. */
export function retryConfig(config: RetryConfig | false | undefined): ResolvedRetry {
	if (config === false) return { attempts: 1, minDelayMs: 0, maxDelayMs: 0 };
	return {
		attempts: Math.max(1, Math.floor(config?.attempts ?? 3)),
		minDelayMs: Math.max(0, Math.floor(config?.minDelayMs ?? 250)),
		maxDelayMs: Math.max(0, Math.floor(config?.maxDelayMs ?? 30_000)),
	};
}

/** Calculate exponential backoff, honoring a server-provided delay when present. */
export function retryDelay(config: ResolvedRetry, attempt: number, retryAfterMs?: number): number {
	const delay = retryAfterMs ?? config.minDelayMs * 2 ** Math.max(0, attempt - 1);
	return Math.min(config.maxDelayMs, Math.max(0, delay));
}

/** Parse an HTTP Retry-After header expressed as seconds or an HTTP date. */
export function retryAfter(value: string | null, now = Date.now()): number | undefined {
	if (!value) return undefined;
	const seconds = Number(value);
	if (Number.isFinite(seconds)) return Math.max(0, seconds * 1_000);
	const date = Date.parse(value);
	return Number.isFinite(date) ? Math.max(0, date - now) : undefined;
}

/** Wait for a retry delay and abort promptly with the caller's signal. */
export async function retryWait(delayMs: number, signal?: AbortSignal): Promise<void> {
	if (signal?.aborted) throw signal.reason ?? new Error("Operation aborted");
	await new Promise<void>((resolve, reject) => {
		const cleanup = () => signal?.removeEventListener("abort", abort);
		const timer = setTimeout(() => {
			cleanup();
			resolve();
		}, delayMs);
		const abort = () => {
			clearTimeout(timer);
			cleanup();
			reject(signal?.reason ?? new Error("Operation aborted"));
		};
		signal?.addEventListener("abort", abort, { once: true });
		if (signal?.aborted) abort();
	});
}

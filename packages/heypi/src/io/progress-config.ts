export type ProgressConfig = {
	delayMs?: number;
};

export function normalizeProgressConfig<T extends ProgressConfig>(input: T | false | undefined): T | undefined {
	if (input === false) return undefined;
	return input ?? ({ delayMs: 0 } as T);
}

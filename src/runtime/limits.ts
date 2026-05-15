import type { RuntimeLimits } from "../config.js";

export type NormalizedRuntimeLimits = {
	maxFileBytes: number;
	maxScanBytes: number;
	maxEntries: number;
};

export function runtimeLimits(input?: RuntimeLimits): NormalizedRuntimeLimits {
	return {
		maxFileBytes: input?.maxFileBytes ?? 1_000_000,
		maxScanBytes: input?.maxScanBytes ?? 5_000_000,
		maxEntries: input?.maxEntries ?? 10_000,
	};
}

export function assertSize(size: number, max: number, label: string): void {
	if (size > max) throw new Error(`${label} exceeds limit: ${size} > ${max}`);
}

export function assertNotAborted(signal?: AbortSignal): void {
	if (signal?.aborted) throw new Error("cancelled");
}

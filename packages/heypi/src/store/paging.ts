export function clampLimit(value: number | undefined, fallback: number, max: number): number {
	return Math.min(Math.max(value ?? fallback, 1), max);
}

export function clampOffset(value: number | undefined): number {
	return Math.max(value ?? 0, 0);
}

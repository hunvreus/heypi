/** Error used by runtime providers when a container, VM, or sandbox fails before execution starts. */
export const RUNTIME_STARTUP_ERROR_KIND = "runtime_startup_failed";

export type RuntimeErrorKind = typeof RUNTIME_STARTUP_ERROR_KIND;

export class RuntimeStartupError extends Error {
	readonly code = RUNTIME_STARTUP_ERROR_KIND;

	constructor(message: string, options?: { cause?: unknown }) {
		super(message, options);
		this.name = "RuntimeStartupError";
	}
}

export function isRuntimeStartupError(error: unknown): error is Error {
	return error instanceof Error && (error instanceof RuntimeStartupError || error.name === "RuntimeStartupError");
}

export function isRuntimeStartupErrorText(text: string | undefined): boolean {
	return /\bruntime failed to start\b/i.test(text ?? "");
}

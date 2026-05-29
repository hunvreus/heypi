export type LogFields = Record<string, unknown>;

/** Builds a log context from stable adapter fields plus call-specific fields. */
export function logCtx(base: LogFields, extra?: LogFields): LogFields {
	return extra ? { ...base, ...extra } : base;
}

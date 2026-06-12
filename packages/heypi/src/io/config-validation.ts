import type { Logger } from "../core/log.js";

const STALE_PERMISSION_KEYS = new Set(["approvers", "admins"]);

export type AdapterConfigValidation = {
	unknownKeys: string[];
};

/** Validates built-in adapter config at construction. Throws for stale security keys, returns warnings to log at start. */
export function validateAdapterConfig(
	adapter: string,
	input: unknown,
	allowed: ReadonlySet<string>,
): AdapterConfigValidation {
	if (!plainObject(input)) throw new Error(`${adapter} config must be an object`);
	const unknownKeys: string[] = [];
	for (const key of Object.keys(input)) {
		if (STALE_PERMISSION_KEYS.has(key)) {
			const label = key === "admins" ? "Admins" : "Approvers";
			throw new Error(
				`${adapter}.${key} is not a valid key. ${label} must be set at ${adapter}.permissions.${key}.`,
			);
		}
		if (!allowed.has(key)) unknownKeys.push(key);
	}
	assertPlainObject(adapter, input, "allow");
	assertPlainObject(adapter, input, "permissions");
	return { unknownKeys };
}

export function warnAdapterConfig(log: Logger, adapter: string, validation: AdapterConfigValidation): void {
	for (const key of validation.unknownKeys) {
		log.warn("config.unknown_key", { path: `${adapter}.${key}` });
	}
}

function assertPlainObject(adapter: string, input: Record<string, unknown>, key: string): void {
	if (!(key in input) || input[key] === undefined) return;
	if (!plainObject(input[key])) throw new Error(`${adapter}.${key} must be an object`);
}

function plainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

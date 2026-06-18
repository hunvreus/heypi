export type EvalExpect =
	| {
			text?: string | RegExp;
			includes?: string;
			tool?: string;
			approval?: boolean | string;
	  }
	| ((input: EvalResult) => void | Promise<void>);

export type EvalResult = {
	text: string;
	tools: string[];
	approvals: string[];
};

export type EvalConfig = {
	name: string;
	prompt: string;
	expect?: EvalExpect | EvalExpect[];
	tags?: string[];
	timeoutMs?: number;
};

/** Defines an agent behavior eval loaded from `agent/evals/` or explicit config. */
export function defineEval(input: EvalConfig): EvalConfig {
	return input;
}

/** Returns human-readable validation errors for an eval definition. */
export function validateEval(input: EvalConfig): string[] {
	const errors: string[] = [];
	const label = evalLabel(input);
	if (!stringNonEmpty(input.name)) errors.push(`${label}: name must be a non-empty string`);
	if (!stringNonEmpty(input.prompt)) errors.push(`${label}: prompt must be a non-empty string`);
	if (input.timeoutMs !== undefined && (!Number.isFinite(input.timeoutMs) || input.timeoutMs <= 0)) {
		errors.push(`${label}: timeoutMs must be a positive number`);
	}
	if (input.tags !== undefined) {
		if (!Array.isArray(input.tags)) {
			errors.push(`${label}: tags must be an array of strings`);
		} else {
			for (const [index, tag] of input.tags.entries()) {
				if (!stringNonEmpty(tag)) errors.push(`${label}: tags[${index}] must be a non-empty string`);
			}
		}
	}
	if (input.expect !== undefined) errors.push(...validateExpect(input.expect, label));
	return errors;
}

function validateExpect(input: EvalExpect | EvalExpect[], label: string): string[] {
	if (Array.isArray(input)) {
		if (!input.length) return [`${label}: expect must not be an empty array`];
		return input.flatMap((row, index) => validateOneExpect(row, `${label}: expect[${index}]`));
	}
	return validateOneExpect(input, `${label}: expect`);
}

function validateOneExpect(input: EvalExpect, label: string): string[] {
	if (typeof input === "function") return [];
	if (!input || typeof input !== "object" || Array.isArray(input)) return [`${label} must be an object or function`];
	const errors: string[] = [];
	const entries = Object.entries(input as Record<string, unknown>);
	if (!entries.length) errors.push(`${label} must define at least one assertion`);
	for (const [key, value] of entries) {
		if (key === "text") {
			if (typeof value !== "string" && !(value instanceof RegExp)) errors.push(`${label}.text must be a string or RegExp`);
		} else if (key === "includes" || key === "tool") {
			if (!stringNonEmpty(value)) errors.push(`${label}.${key} must be a non-empty string`);
		} else if (key === "approval") {
			if (typeof value !== "boolean" && !stringNonEmpty(value)) {
				errors.push(`${label}.approval must be a boolean or non-empty string`);
			}
		} else {
			errors.push(`${label}.${key} is not a supported assertion`);
		}
	}
	return errors;
}

function evalLabel(input: EvalConfig): string {
	return stringNonEmpty(input.name) ? `eval ${input.name}` : "eval";
}

function stringNonEmpty(input: unknown): input is string {
	return typeof input === "string" && input.trim().length > 0;
}

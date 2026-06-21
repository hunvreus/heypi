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

export type EvalAssertion = {
	ok: boolean;
	label: string;
	message?: string;
};

export type EvalReport = {
	ok: boolean;
	assertions: EvalAssertion[];
};

export type EvalConfig = {
	name: string;
	prompt: string;
	expect?: EvalExpect | EvalExpect[];
	tags?: string[];
	timeoutMs?: number;
};

/** Defines an agent behavior eval loaded from root `evals/` or explicit config. */
export function defineEval(input: EvalConfig): EvalConfig {
	return input;
}

/** Returns a JSON-safe representation of eval expectations for CLI/API display. */
export function evalExpectSummary(input: EvalConfig["expect"]): unknown {
	if (!input) return undefined;
	if (typeof input === "function") return "custom";
	if (Array.isArray(input)) return input.map(evalExpectSummary);
	return Object.fromEntries(
		Object.entries(input).map(([key, value]) => [key, value instanceof RegExp ? value.toString() : value]),
	);
}

/** Returns a compact one-line label for eval expectations. */
export function evalExpectLabel(input: EvalConfig["expect"]): string {
	if (!input) return "-";
	const rows = Array.isArray(input) ? input : [input];
	return rows.map(oneExpectLabel).join(", ");
}

/** Returns a multi-line label for detailed eval expectation inspection. */
export function evalExpectDetail(input: EvalConfig["expect"]): string {
	if (!input) return "-";
	const rows = Array.isArray(input) ? input : [input];
	return rows.map((row, index) => `${rows.length > 1 ? `${index + 1}. ` : ""}${oneExpectLabel(row)}`).join("\n");
}

/** Evaluates a result against text, tool, approval, and custom assertions. */
export async function evaluateEval(input: Pick<EvalConfig, "expect">, result: EvalResult): Promise<EvalReport> {
	const expectations = expectList(input.expect);
	const assertions: EvalAssertion[] = [];
	for (const expect of expectations) {
		assertions.push(...(await evaluateOne(expect, result)));
	}
	return { ok: assertions.every((row) => row.ok), assertions };
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
			if (typeof value !== "string" && !(value instanceof RegExp))
				errors.push(`${label}.text must be a string or RegExp`);
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

function expectList(input: EvalConfig["expect"]): EvalExpect[] {
	if (!input) return [];
	return Array.isArray(input) ? input : [input];
}

function oneExpectLabel(input: EvalExpect): string {
	if (typeof input === "function") return "custom";
	return Object.entries(input)
		.map(([key, value]) => `${key}:${value instanceof RegExp ? value.toString() : String(value)}`)
		.join("+");
}

async function evaluateOne(expect: EvalExpect, result: EvalResult): Promise<EvalAssertion[]> {
	if (typeof expect === "function") {
		try {
			await expect(result);
			return [{ ok: true, label: "custom" }];
		} catch (error) {
			return [{ ok: false, label: "custom", message: errorMessage(error) }];
		}
	}
	const assertions: EvalAssertion[] = [];
	if (expect.text !== undefined) {
		const ok = expect.text instanceof RegExp ? expect.text.test(result.text) : result.text === expect.text;
		assertions.push({
			ok,
			label: "text",
			message: ok
				? undefined
				: `expected text ${expect.text instanceof RegExp ? expect.text.toString() : JSON.stringify(expect.text)}`,
		});
	}
	if (expect.includes !== undefined) {
		const ok = result.text.includes(expect.includes);
		assertions.push({
			ok,
			label: "includes",
			message: ok ? undefined : `expected text to include ${JSON.stringify(expect.includes)}`,
		});
	}
	if (expect.tool !== undefined) {
		const ok = result.tools.includes(expect.tool);
		assertions.push({ ok, label: "tool", message: ok ? undefined : `expected tool ${expect.tool}` });
	}
	if (expect.approval !== undefined) {
		if (typeof expect.approval === "boolean") {
			const ok = expect.approval ? result.approvals.length > 0 : result.approvals.length === 0;
			assertions.push({
				ok,
				label: "approval",
				message: ok
					? undefined
					: expect.approval
						? "expected an approval request"
						: "expected no approval requests",
			});
		} else {
			const ok = result.approvals.includes(expect.approval);
			assertions.push({ ok, label: "approval", message: ok ? undefined : `expected approval ${expect.approval}` });
		}
	}
	return assertions;
}

function stringNonEmpty(input: unknown): input is string {
	return typeof input === "string" && input.trim().length > 0;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

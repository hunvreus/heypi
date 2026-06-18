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

import { commandConfirm } from "./core/policy.js";
import type { CommandPolicyConfig, Confirm, ConfirmFunction } from "./core/types.js";

type ApprovalInput = Record<string, unknown>;
type ApprovalPredicate<T extends ApprovalInput = ApprovalInput> = (input: T) => boolean;

/** Creates common tool approval policies for `defineTool` and runtime tools. */
export const approval = {
	always(message: string): Confirm {
		return { message };
	},
	never(): ConfirmFunction {
		return () => false;
	},
	when<T extends ApprovalInput = ApprovalInput>(predicate: ApprovalPredicate<T>, message: string): ConfirmFunction {
		return (input) => (predicate(input as T) ? { message } : false);
	},
	command(config: CommandPolicyConfig = {}): ConfirmFunction {
		return commandConfirm(config);
	},
};

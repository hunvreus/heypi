import type { CallState } from "./types.js";

const ALLOWED: Record<CallState, CallState[]> = {
	running: ["done", "failed", "cancelled"],
	pending_approval: ["running", "blocked", "cancelled"],
	blocked: [],
	done: [],
	failed: [],
	cancelled: [],
};

export function assertTransition(from: CallState, to: CallState): void {
	if (from === to) return;
	if (!ALLOWED[from].includes(to)) {
		throw new Error(`invalid transition ${from} -> ${to}`);
	}
}

export function parseCallState(value: string): CallState {
	if (
		value === "running" ||
		value === "pending_approval" ||
		value === "blocked" ||
		value === "done" ||
		value === "failed" ||
		value === "cancelled"
	) {
		return value;
	}
	throw new Error(`invalid call state: ${value}`);
}

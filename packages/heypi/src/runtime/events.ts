import type { Runtime, RuntimeEventHandler } from "./types.js";

/** Returns a runtime proxy that forwards provider lifecycle events with each operation. */
export function runtimeWithEvents(runtime: Runtime, runtimeEvents?: RuntimeEventHandler): Runtime {
	if (!runtimeEvents) return runtime;
	return {
		...runtime,
		bash: runtime.bash ? (input) => runtime.bash!({ ...input, runtimeEvents }) : undefined,
		read: runtime.read ? (input) => runtime.read!({ ...input, runtimeEvents }) : undefined,
		write: runtime.write ? (input) => runtime.write!({ ...input, runtimeEvents }) : undefined,
		edit: runtime.edit ? (input) => runtime.edit!({ ...input, runtimeEvents }) : undefined,
		grep: runtime.grep ? (input) => runtime.grep!({ ...input, runtimeEvents }) : undefined,
		find: runtime.find ? (input) => runtime.find!({ ...input, runtimeEvents }) : undefined,
		ls: runtime.ls ? (input) => runtime.ls!({ ...input, runtimeEvents }) : undefined,
	};
}

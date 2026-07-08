import type { Logger } from "./types.js";

type LogLevel = "debug" | "info" | "warn" | "error";

function write(level: LogLevel, event: string, data?: Record<string, unknown>): void {
	const suffix = data && Object.keys(data).length > 0 ? ` ${JSON.stringify(data)}` : "";
	console[level](`[heypi] ${event}${suffix}`);
}

export const consoleLogger: Logger = {
	debug: (event, data) => write("debug", event, data),
	info: (event, data) => write("info", event, data),
	warn: (event, data) => write("warn", event, data),
	error: (event, data) => write("error", event, data),
	ready: (info) => {
		const lines = ["[heypi] ready", `  Agent: ${info.agent}`];
		if (info.admin) lines.push(`  Admin: ${info.admin}`);
		if (info.adapters.length > 0) lines.push(`  Adapters: ${info.adapters.join(", ")}`);
		console.info(lines.join("\n"));
	},
};

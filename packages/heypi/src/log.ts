import type { Logger } from "./types.js";

function write(level: keyof Logger, event: string, data?: Record<string, unknown>): void {
	const suffix = data && Object.keys(data).length > 0 ? ` ${JSON.stringify(data)}` : "";
	console[level](`[heypi] ${event}${suffix}`);
}

export const consoleLogger: Logger = {
	debug: (event, data) => write("debug", event, data),
	info: (event, data) => write("info", event, data),
	warn: (event, data) => write("warn", event, data),
	error: (event, data) => write("error", event, data),
};

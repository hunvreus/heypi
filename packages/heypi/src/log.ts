import type { Logger, LogLevel } from "./types.js";

function line(level: LogLevel, event: string, data?: Record<string, unknown>): void {
	const suffix = data && Object.keys(data).length > 0 ? ` ${JSON.stringify(data)}` : "";
	process.stderr.write(`[heypi] ${level} ${event}${suffix}\n`);
}

export const consoleLogger: Logger = {
	debug: (event, data) => line("debug", event, data),
	info: (event, data) => line("info", event, data),
	warn: (event, data) => line("warn", event, data),
	error: (event, data) => line("error", event, data),
};

export type { Logger };


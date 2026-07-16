import type { Logger } from "./types.js";

type LogLevel = "debug" | "info" | "warn" | "error";

function colorEnabled(): boolean {
	if (process.env.NO_COLOR) return false;
	if (process.env.FORCE_COLOR && process.env.FORCE_COLOR !== "0") return true;
	return Boolean(process.stderr.isTTY || process.stdout.isTTY);
}

const colors = colorEnabled();

function color(open: number, value: string): string {
	return colors ? `\u001b[${open}m${value}\u001b[0m` : value;
}

function eventLabel(level: LogLevel, event: string): string {
	if (level === "warn") return color(33, event);
	if (level === "error") return color(31, event);
	if (level === "debug") return color(2, event);
	return event;
}

function write(level: LogLevel, event: string, data?: Record<string, unknown>): void {
	const suffix = data && Object.keys(data).length > 0 ? ` ${JSON.stringify(data)}` : "";
	console[level](`[heypi] ${eventLabel(level, event)}${suffix}`);
}

export const consoleLogger: Logger = {
	debug: (event, data) => write("debug", event, data),
	info: (event, data) => write("info", event, data),
	warn: (event, data) => write("warn", event, data),
	error: (event, data) => write("error", event, data),
	ready: (info) => {
		const lines = [`[heypi] ${color(32, "ready")}`, `  Agent: ${info.agent}`];
		if (info.admin) lines.push(`  Admin: ${info.admin}`);
		if (info.adapters.length > 0) lines.push(`  Adapters: ${info.adapters.join(", ")}`);
		console.info(lines.join("\n"));
	},
};

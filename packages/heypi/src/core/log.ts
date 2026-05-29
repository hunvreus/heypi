const SECRET =
	/(?:sk|xox[baprs]?|xapp)-[A-Za-z0-9_*.-]+|\b[A-Za-z0-9_-]{24,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{27,}\b|gh[pousr]_[A-Za-z0-9_]+|(?:AKIA|ASIA)[A-Z0-9]{16}|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g;

export type Level = "debug" | "info" | "warn" | "error";
export type Format = "pretty" | "json";

export type Logger = {
	debug(event: string, input?: Record<string, unknown>): void;
	info(event: string, input?: Record<string, unknown>): void;
	warn(event: string, input?: Record<string, unknown>): void;
	error(event: string, input?: Record<string, unknown>): void;
};

const LEVELS: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export const logger = consoleLogger({ level: "info" });

/** Creates a small structured logger. Pretty is for local dev; json is for log collectors. */
export function consoleLogger(input: { level?: Level; format?: Format } = {}): Logger {
	const min = LEVELS[input.level ?? "info"];
	const format = input.format ?? "pretty";
	return {
		debug: (event, data) => write("debug", min, format, event, data),
		info: (event, data) => write("info", min, format, event, data),
		warn: (event, data) => write("warn", min, format, event, data),
		error: (event, data) => write("error", min, format, event, data),
	};
}

export function userError(message?: string): string {
	return message ?? "Something went wrong. Ask an admin to check the server logs.";
}

export function logError(log: Logger, kind: "handler" | "model", input: Record<string, unknown>): void {
	log.error(`${kind}.error`, input);
}

export function message(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export function redact(text: string): string {
	return text.replace(SECRET, (value) => `${prefix(value)}<redacted>`);
}

function prefix(value: string): string {
	if (value.startsWith("eyJ")) return "jwt:";
	if (value.startsWith("AKIA") || value.startsWith("ASIA")) return value.slice(0, 4);
	if (value.includes(".")) return "";
	const dash = value.indexOf("-");
	if (dash > 0) return value.slice(0, dash + 1);
	const underscore = value.indexOf("_");
	if (underscore > 0) return value.slice(0, underscore + 1);
	return "";
}

function write(level: Level, min: number, format: Format, event: string, input: Record<string, unknown> = {}): void {
	if (LEVELS[level] < min) return;
	const data = clean(input);
	const method = methodFor(level);
	if (format === "json") {
		method(JSON.stringify({ time: new Date().toISOString(), level, event, ...data }));
		return;
	}
	const fields = Object.entries(data).map(([key, value]) => `${key}=${valueText(value)}`);
	const prefix = prettyPrefix(level);
	const line = fields.length > 0 ? `${prefix} ${event} ${fields.join(" ")}` : `${prefix} ${event}`;
	method(colorLine(level, line));
}

function prettyPrefix(level: Level): string {
	if (level === "warn" || level === "error") return `[heypi] ${level.toUpperCase()}`;
	return "[heypi]";
}

function colorLine(level: Level, line: string): string {
	if (!shouldColor(level)) return line;
	if (level === "warn") return `\x1b[33m${line}\x1b[0m`;
	if (level === "error") return `\x1b[31m${line}\x1b[0m`;
	if (level === "debug") return `\x1b[2m${line}\x1b[0m`;
	return line;
}

function shouldColor(level: Level): boolean {
	if (process.env.FORCE_COLOR && process.env.FORCE_COLOR !== "0") return true;
	if (process.env.NO_COLOR) return false;
	const stream = level === "warn" || level === "error" ? process.stderr : process.stdout;
	return stream.isTTY === true;
}

function methodFor(level: Level): (message?: unknown, ...optional: unknown[]) => void {
	if (level === "debug") return console.debug;
	if (level === "warn") return console.warn;
	if (level === "error") return console.error;
	return console.info;
}

function clean(input: Record<string, unknown>): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(input)) out[key] = cleanValue(value);
	return out;
}

function cleanValue(value: unknown): unknown {
	if (typeof value === "string") return redact(value);
	if (Array.isArray(value)) return value.map((item) => cleanValue(item));
	if (isPlainObject(value)) {
		const out: Record<string, unknown> = {};
		for (const [key, child] of Object.entries(value)) out[key] = cleanValue(child);
		return out;
	}
	return value;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	if (value === null || typeof value !== "object") return false;
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

function valueText(value: unknown): string {
	if (typeof value === "string") return needsQuotes(value) ? JSON.stringify(value) : value;
	if (value === undefined) return "undefined";
	return JSON.stringify(value);
}

function needsQuotes(value: string): boolean {
	return value.length === 0 || /\s|=/.test(value);
}

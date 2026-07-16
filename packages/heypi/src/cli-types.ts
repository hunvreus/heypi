import type { CliEnvironment } from "./cli-env.js";

export type CliResult = {
	data: unknown;
	lines: string[];
	ok?: boolean;
};

export type CliContext = {
	environment: CliEnvironment;
	fetch: typeof fetch;
	discordGateway: (token: string, fetcher: typeof fetch) => Promise<void>;
};

export type CliFlags = Map<string, string | true>;

export function flag(flags: CliFlags, name: string): string | undefined {
	const value = flags.get(name);
	return typeof value === "string" ? value : undefined;
}

export function booleanFlag(flags: CliFlags, name: string): boolean {
	return flags.get(name) === true;
}

import { readFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { parseEnv } from "node:util";

const SECRET_KEY = /(token|secret|password|webhook)/i;
const TOKEN_URL = /(https:\/\/api\.telegram\.org\/bot)[^/\s]+/gi;
const SECRET_QUERY = /([?&](?:token|secret|key|signature)=)[^&#\s]+/gi;

export type CliEnvironment = Record<string, string | undefined>;

async function readEnvironment(path: string, required: boolean): Promise<CliEnvironment> {
	try {
		return parseEnv(await readFile(path, "utf8"));
	} catch (error) {
		if (!required && error instanceof Error && "code" in error && error.code === "ENOENT") return {};
		throw new Error(`Could not load environment file: ${path}`);
	}
}

/** Loads CLI environment files without replacing variables already exported by the caller. */
export async function loadCliEnvironment(
	cwd: string,
	base: CliEnvironment,
	explicit?: string,
): Promise<CliEnvironment> {
	if (explicit) {
		const path = isAbsolute(explicit) ? explicit : resolve(cwd, explicit);
		return { ...(await readEnvironment(path, true)), ...base };
	}
	const defaults = await readEnvironment(join(cwd, ".env"), false);
	const local = await readEnvironment(join(cwd, ".env.local"), false);
	return { ...defaults, ...local, ...base };
}

function secrets(environment: CliEnvironment): string[] {
	return Object.entries(environment)
		.filter(([key, value]) => SECRET_KEY.test(key) && typeof value === "string" && value.length >= 6)
		.map(([, value]) => value as string)
		.sort((left, right) => right.length - left.length);
}

/** Redacts configured secrets and common token-bearing URL forms from CLI output. */
export function redactCliText(value: string, environment: CliEnvironment): string {
	let result = value.replace(TOKEN_URL, "$1[redacted]").replace(SECRET_QUERY, "$1[redacted]");
	for (const secret of secrets(environment)) result = result.replaceAll(secret, "[redacted]");
	return result;
}

export function requiredEnvironment(environment: CliEnvironment, key: string): string {
	const value = environment[key]?.trim();
	if (!value) throw new Error(`Missing ${key}. Set it in the environment or an env file.`);
	return value;
}

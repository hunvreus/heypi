import { spawn } from "node:child_process";
import { readdir } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";

export function guardPathInput(
	tool: ToolDefinition<any, any, any>,
	guard: (path: string) => void,
	fields: string[],
): ToolDefinition<any, any, any> {
	return {
		...tool,
		async execute(toolCallId, input, signal, onUpdate, ctx) {
			if (input && typeof input === "object") {
				for (const field of fields) {
					const value = (input as Record<string, unknown>)[field];
					if (typeof value === "string") guard(value);
				}
			}
			return tool.execute(toolCallId, input, signal, onUpdate, ctx);
		},
	};
}

export function mapPathInput(
	tool: ToolDefinition<any, any, any>,
	map: (path: string) => string,
	fields: string[],
): ToolDefinition<any, any, any> {
	return {
		...tool,
		async execute(toolCallId, input, signal, onUpdate, ctx) {
			const next = input && typeof input === "object" ? { ...(input as Record<string, unknown>) } : input;
			if (next && typeof next === "object") {
				for (const field of fields) {
					const value = (next as Record<string, unknown>)[field];
					if (typeof value === "string") (next as Record<string, unknown>)[field] = map(value);
				}
			}
			return tool.execute(toolCallId, next, signal, onUpdate, ctx);
		},
	};
}

export function globPattern(pattern: string): RegExp {
	let source = "^";
	for (let index = 0; index < pattern.length; index++) {
		const char = pattern[index];
		const next = pattern[index + 1];
		const afterNext = pattern[index + 2];
		if (char === "*" && next === "*" && afterNext === "/") {
			source += "(?:.*/)?";
			index += 2;
		} else if (char === "*" && next === "*") {
			source += ".*";
			index++;
		} else if (char === "*") {
			source += "[^/]*";
		} else if (char === "?") {
			source += "[^/]";
		} else {
			source += char.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
		}
	}
	return new RegExp(`${source}$`);
}

export async function findFiles(
	root: string,
	pattern: string,
	options: { ignore: string[]; limit: number },
): Promise<string[]> {
	const matcher = globPattern(pattern.includes("/") ? pattern : `**/${pattern}`);
	const results: string[] = [];
	const ignored = new Set(options.ignore.map((entry) => entry.replace(/^\*\*\//, "").replace(/\/\*\*$/, "")));

	async function visit(dir: string): Promise<void> {
		if (results.length >= options.limit) return;
		const entries = await readdir(dir, { withFileTypes: true });
		for (const entry of entries) {
			if (results.length >= options.limit) return;
			if (ignored.has(entry.name)) continue;
			const absolute = resolve(dir, entry.name);
			if (entry.isDirectory()) {
				await visit(absolute);
				continue;
			}
			const relativePath = relative(root, absolute).split(sep).join("/");
			if (matcher.test(relativePath)) results.push(relativePath);
		}
	}

	await visit(root);
	return results;
}

export function runBuffer(
	command: string,
	args: string[],
	options: { signal?: AbortSignal; input?: string | Buffer } = {},
): Promise<Buffer> {
	return new Promise((resolvePromise, reject) => {
		const child = spawn(command, args, { stdio: [options.input === undefined ? "ignore" : "pipe", "pipe", "pipe"] });
		const stdout: Buffer[] = [];
		let stderr = "";
		const abort = () => child.kill("SIGTERM");
		options.signal?.addEventListener("abort", abort, { once: true });
		if (options.input !== undefined && child.stdin) child.stdin.end(options.input);
		child.stdout?.on("data", (chunk) => {
			stdout.push(Buffer.from(chunk));
		});
		child.stderr?.on("data", (chunk) => {
			stderr += chunk.toString();
		});
		child.on("error", reject);
		child.on("close", (code) => {
			options.signal?.removeEventListener("abort", abort);
			if (code === 0) resolvePromise(Buffer.concat(stdout));
			else
				reject(
					new Error(
						stderr.trim() || Buffer.concat(stdout).toString().trim() || `${command} exited with code ${code}`,
					),
				);
		});
	});
}

export async function run(command: string, args: string[], options: { signal?: AbortSignal } = {}): Promise<string> {
	return (await runBuffer(command, args, options)).toString().trim();
}

import { spawn } from "node:child_process";

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

import { spawn } from "node:child_process";
import type { BashResult } from "./types.js";

const MAX_CHARS = 64 * 1024;

export function clip(value: string): string {
	if (value.length <= MAX_CHARS) return value;
	return `...[truncated]\n${value.slice(value.length - MAX_CHARS)}`;
}

export async function executeBash(
	command: string,
	options: { cwd: string; timeoutMs: number; env: NodeJS.ProcessEnv; signal?: AbortSignal },
): Promise<BashResult> {
	const start = Date.now();
	return await new Promise((resolve) => {
		if (options.signal?.aborted) {
			resolve({ code: 130, out: "", err: "Command cancelled", ms: Date.now() - start });
			return;
		}
		const proc = spawn("bash", ["-lc", command], {
			cwd: options.cwd,
			env: options.env,
			stdio: ["ignore", "pipe", "pipe"],
		});

		let out = "";
		let err = "";
		let done = false;

		const finish = (result: BashResult) => {
			if (done) return;
			done = true;
			clearTimeout(timer);
			options.signal?.removeEventListener("abort", onAbort);
			resolve(result);
		};

		const onAbort = () => {
			proc.kill("SIGKILL");
			finish({ code: 130, out: clip(out), err: clip(`${err}\nCommand cancelled`), ms: Date.now() - start });
		};

		const timer = setTimeout(() => {
			proc.kill("SIGKILL");
			finish({ code: 124, out: clip(out), err: clip(`${err}\nCommand timed out`), ms: Date.now() - start });
		}, options.timeoutMs);
		options.signal?.addEventListener("abort", onAbort, { once: true });

		proc.stdout.on("data", (buf: Buffer) => {
			out += buf.toString("utf8");
		});
		proc.stderr.on("data", (buf: Buffer) => {
			err += buf.toString("utf8");
		});
		proc.on("close", (code) => {
			finish({ code: code ?? 1, out: clip(out), err: clip(err), ms: Date.now() - start });
		});
	});
}

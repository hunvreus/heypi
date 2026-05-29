import { spawn } from "node:child_process";
import type { BashResult } from "./types.js";

const MAX_CHARS = 64 * 1024;
const STREAM_CAP = MAX_CHARS * 4;

export function clip(value: string): string {
	if (value.length <= MAX_CHARS) return value;
	return `...[truncated]\n${value.slice(value.length - MAX_CHARS)}`;
}

export async function executeBash(
	command: string,
	options: { cwd: string; timeoutMs: number; env: NodeJS.ProcessEnv; signal?: AbortSignal },
): Promise<BashResult> {
	return await executeProcess("bash", ["-c", command], options);
}

export async function executeProcess(
	command: string,
	args: string[],
	options: { cwd: string; timeoutMs: number; env: NodeJS.ProcessEnv; signal?: AbortSignal },
): Promise<BashResult> {
	const start = Date.now();
	return await new Promise((resolve) => {
		if (options.signal?.aborted) {
			resolve({ code: 130, out: "", err: "Command cancelled", ms: Date.now() - start });
			return;
		}
		const proc = spawn(command, args, {
			cwd: options.cwd,
			env: options.env,
			stdio: ["ignore", "pipe", "pipe"],
		});

		let out = "";
		let err = "";
		let done = false;
		let capped = false;

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
			const chunk = buf.toString("utf8");
			if (appendOutput(chunk, "out")) return;
			proc.kill("SIGKILL");
			finish({
				code: 125,
				out: clip(out),
				err: clip(`${err}\nCommand output exceeded ${STREAM_CAP} characters`),
				ms: Date.now() - start,
			});
		});
		proc.stderr.on("data", (buf: Buffer) => {
			const chunk = buf.toString("utf8");
			if (appendOutput(chunk, "err")) return;
			proc.kill("SIGKILL");
			finish({
				code: 125,
				out: clip(out),
				err: clip(`${err}\nCommand output exceeded ${STREAM_CAP} characters`),
				ms: Date.now() - start,
			});
		});
		proc.on("error", (error) => {
			finish({ code: 127, out: clip(out), err: clip(`${err}${error.message}`), ms: Date.now() - start });
		});
		proc.on("close", (code) => {
			finish({ code: code ?? 1, out: clip(out), err: clip(err), ms: Date.now() - start });
		});

		function appendOutput(chunk: string, stream: "out" | "err"): boolean {
			if (capped) return false;
			const remaining = STREAM_CAP - out.length - err.length;
			if (remaining <= 0) {
				capped = true;
				return false;
			}
			if (chunk.length <= remaining) {
				if (stream === "out") out += chunk;
				else err += chunk;
				return true;
			}
			const truncated = `${chunk.slice(0, remaining)}\n...[truncated mid-stream]\n`;
			if (stream === "out") out += truncated;
			else err += truncated;
			capped = true;
			return false;
		}
	});
}

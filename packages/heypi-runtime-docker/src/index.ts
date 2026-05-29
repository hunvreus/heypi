import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { posix } from "node:path";
import type {
	BashResult,
	EditResult,
	FindResult,
	GrepHit,
	GrepResult,
	LsEntry,
	LsResult,
	ReadResult,
	Runtime,
	RuntimeProvider,
	RuntimeScope,
	WriteResult,
} from "@hunvreus/heypi/runtime";

export type RuntimeToolLimits = {
	maxFileBytes?: number;
	maxScanBytes?: number;
	maxEntries?: number;
};

export type DockerRuntimeConfig = {
	image?: string;
	docker?: string;
	prefix?: string;
	workdir?: string;
	network?: "none" | "host" | "bridge" | string;
	env?: Record<string, string>;
	user?: string | false;
	extraRunArgs?: string[];
	timeoutMs?: number;
	idleMs?: number | false;
	limits?: RuntimeToolLimits;
	runner?: DockerCommandRunner;
};

export type DockerCommandRunner = (
	command: string,
	args: string[],
	options: { timeoutMs: number; signal?: AbortSignal; input?: string | Buffer },
) => Promise<BashResult>;

/** Creates a Docker-backed heypi runtime provider with one warm container per runtime scope. */
export function dockerRuntime(config: DockerRuntimeConfig = {}): RuntimeProvider {
	return new DockerRuntimeProvider(config);
}

class DockerRuntimeProvider implements RuntimeProvider {
	private readonly scopes = new Map<string, DockerScopeRuntime>();

	constructor(private readonly config: DockerRuntimeConfig) {}

	get(scope: RuntimeScope): Runtime {
		const key = scope.path;
		const cached = this.scopes.get(key);
		if (cached) return cached.runtime();
		const next = new DockerScopeRuntime(scope, this.config);
		this.scopes.set(key, next);
		return next.runtime();
	}

	async close(): Promise<void> {
		await Promise.allSettled([...this.scopes.values()].map((scope) => scope.stop()));
		this.scopes.clear();
	}
}

class DockerScopeRuntime {
	private readonly docker: string;
	private readonly image: string;
	private readonly workdir: string;
	private readonly timeoutMs: number;
	private readonly idleMs: number | false;
	private readonly limits: Required<RuntimeToolLimits>;
	private readonly runner: DockerCommandRunner;
	private starting: Promise<string> | undefined;
	private container: string | undefined;
	private idleTimer: NodeJS.Timeout | undefined;

	constructor(
		private readonly scope: RuntimeScope,
		private readonly config: DockerRuntimeConfig,
	) {
		this.docker = config.docker ?? "docker";
		this.image = config.image ?? "debian:bookworm-slim";
		this.workdir = config.workdir ?? "/workspace";
		this.timeoutMs = config.timeoutMs ?? 120_000;
		this.idleMs = config.idleMs === undefined ? 10 * 60 * 1000 : config.idleMs;
		this.limits = runtimeLimits(config.limits);
		this.runner = config.runner ?? runCommand;
	}

	runtime(): Runtime {
		return {
			name: "docker",
			root: this.scope.root,
			bash: (input) => this.bash(input),
			read: (input) => this.read(input),
			write: (input) => this.write(input),
			edit: (input) => this.edit(input),
			grep: (input) => this.grep(input),
			find: (input) => this.find(input),
			ls: (input) => this.ls(input),
		};
	}

	async stop(): Promise<void> {
		this.clearIdleTimer();
		const container = this.container;
		this.container = undefined;
		this.starting = undefined;
		if (container)
			await this.runner(this.docker, ["rm", "-f", container], { timeoutMs: 30_000 }).catch(() => undefined);
	}

	private async ensureContainer(signal?: AbortSignal): Promise<string> {
		if (this.container) return this.container;
		if (this.starting) return await this.starting;
		this.starting = this.startContainer(signal);
		try {
			this.container = await this.starting;
			this.scheduleIdleStop();
			return this.container;
		} finally {
			this.starting = undefined;
		}
	}

	private async startContainer(signal?: AbortSignal): Promise<string> {
		await mkdir(this.scope.root, { recursive: true });
		const name = this.containerName();
		const inspect = await this.runner(this.docker, ["inspect", "-f", "{{.State.Running}}", name], {
			timeoutMs: 10_000,
			signal,
		}).catch(() => undefined);
		if (inspect?.code === 0 && inspect.out.trim() === "true") return name;
		await this.runner(this.docker, ["rm", "-f", name], { timeoutMs: 30_000, signal }).catch(() => undefined);

		const args = [
			"run",
			"-d",
			"--name",
			name,
			"--workdir",
			this.workdir,
			"-v",
			`${this.scope.root}:${this.workdir}:rw`,
			"--network",
			this.config.network ?? "none",
		];
		if (this.config.user) args.push("--user", this.config.user);
		for (const [key, value] of Object.entries(this.config.env ?? {})) args.push("-e", `${key}=${value}`);
		args.push(...(this.config.extraRunArgs ?? []), this.image, "sleep", "infinity");

		const started = await this.runner(this.docker, args, { timeoutMs: this.timeoutMs, signal });
		if (started.code !== 0) throw new Error(started.err || `failed to start Docker container ${name}`);
		return name;
	}

	private containerName(): string {
		const hash = createHash("sha256").update(this.scope.path).digest("hex").slice(0, 16);
		const prefix = this.config.prefix ?? "heypi";
		return `${prefix}-${hash}`;
	}

	private scheduleIdleStop(): void {
		this.clearIdleTimer();
		if (!this.idleMs || this.idleMs <= 0) return;
		this.idleTimer = setTimeout(() => {
			void this.stop();
		}, this.idleMs);
		this.idleTimer.unref?.();
	}

	private clearIdleTimer(): void {
		if (!this.idleTimer) return;
		clearTimeout(this.idleTimer);
		this.idleTimer = undefined;
	}

	private async bash({
		command,
		timeoutMs,
		signal,
	}: {
		command: string;
		timeoutMs?: number;
		signal?: AbortSignal;
	}): Promise<BashResult> {
		const container = await this.ensureContainer(signal);
		const result = await this.runner(this.docker, ["exec", "-i", container, "bash", "-lc", command], {
			timeoutMs: timeoutMs ?? this.timeoutMs,
			signal,
		});
		this.scheduleIdleStop();
		return result;
	}

	private async read({
		path,
		offset,
		limit,
		signal,
	}: {
		path: string;
		offset?: number;
		limit?: number;
		signal?: AbortSignal;
	}): Promise<ReadResult> {
		const normalized = workspacePath(path);
		const out = await this.sh(READ_SCRIPT, [shellPath(normalized), String(this.limits.maxFileBytes)], {
			signal,
		});
		const marker = out.indexOf("\n");
		const header = marker === -1 ? out : out.slice(0, marker);
		if (header !== "__HEYPI_FILE__") throw new Error(`invalid read response for ${normalized}`);
		const text = marker === -1 ? "" : out.slice(marker + 1);
		const lines = text.split(/\r?\n/);
		const start = offset ? Math.max(0, offset - 1) : 0;
		const end = limit ? start + limit : lines.length;
		return { path: normalized, text: lines.slice(start, end).join("\n"), lines: lines.length };
	}

	private async write({ path, content }: { path: string; content: string }): Promise<WriteResult> {
		const normalized = workspacePath(path);
		assertSize(Buffer.byteLength(content), this.limits.maxFileBytes, normalized);
		const out = await this.sh(WRITE_SCRIPT, [shellPath(normalized)], { input: content });
		return { path: normalized, bytes: Number(out.trim()) || Buffer.byteLength(content) };
	}

	private async edit({
		path,
		oldText,
		newText,
		replaceAll,
	}: {
		path: string;
		oldText: string;
		newText: string;
		replaceAll?: boolean;
	}): Promise<EditResult> {
		const current = await this.read({ path });
		const count = current.text.split(oldText).length - 1;
		if (count === 0) throw new Error(`text not found in ${current.path}`);
		if (!replaceAll && count > 1) throw new Error(`text is not unique in ${current.path}`);
		const next = replaceAll ? current.text.replaceAll(oldText, newText) : current.text.replace(oldText, newText);
		await this.write({ path: current.path, content: next });
		return { path: current.path, replacements: replaceAll ? count : 1 };
	}

	private async grep({
		query,
		path = ".",
		maxResults = 100,
		signal,
	}: {
		query: string;
		path?: string;
		maxResults?: number;
		signal?: AbortSignal;
	}): Promise<GrepResult> {
		const out = await this.sh(
			GREP_SCRIPT,
			[
				shellPath(workspacePath(path)),
				query,
				String(Math.max(1, maxResults)),
				String(this.limits.maxFileBytes),
				String(this.limits.maxScanBytes),
				String(this.limits.maxEntries),
			],
			{ signal },
		);
		const hits: GrepHit[] = [];
		for (const line of out.split("\n")) {
			if (!line) continue;
			const [hitPath, hitLine, text] = splitColumns(line, 3);
			hits.push({ path: hitPath, line: Number(hitLine) || 0, text });
		}
		return { hits };
	}

	private async find({
		pattern,
		path = ".",
		maxResults = 1000,
		signal,
	}: {
		pattern?: string;
		path?: string;
		maxResults?: number;
		signal?: AbortSignal;
	}): Promise<FindResult> {
		const limit = Math.min(Math.max(1, maxResults), this.limits.maxEntries);
		const out = await this.sh(FIND_SCRIPT, [shellPath(workspacePath(path)), String(limit)], { signal });
		return {
			paths: out
				.split("\n")
				.filter((entry) => entry && match(entry, pattern))
				.slice(0, maxResults),
		};
	}

	private async ls({ path = ".", signal }: { path?: string; signal?: AbortSignal }): Promise<LsResult> {
		const out = await this.sh(LS_SCRIPT, [shellPath(workspacePath(path)), String(this.limits.maxEntries)], {
			signal,
		});
		const entries: LsEntry[] = [];
		for (const line of out.split("\n")) {
			if (!line) continue;
			const [name, entryPath, type, size] = splitColumns(line, 4);
			entries.push({
				name,
				path: entryPath,
				type: type === "directory" || type === "file" ? type : "other",
				size: Number(size) || 0,
			});
		}
		return { entries };
	}

	private async sh(
		script: string,
		args: string[],
		options: { signal?: AbortSignal; input?: string | Buffer; timeoutMs?: number } = {},
	): Promise<string> {
		const container = await this.ensureContainer(options.signal);
		const result = await this.runner(this.docker, ["exec", "-i", container, "sh", "-c", script, "heypi", ...args], {
			timeoutMs: options.timeoutMs ?? this.timeoutMs,
			signal: options.signal,
			input: options.input,
		});
		this.scheduleIdleStop();
		if (result.code !== 0) throw new Error(result.err.trim() || result.out.trim() || "Docker runtime command failed");
		return result.out;
	}
}

async function runCommand(
	command: string,
	args: string[],
	options: { timeoutMs: number; signal?: AbortSignal; input?: string | Buffer },
): Promise<BashResult> {
	const start = Date.now();
	return await new Promise((resolve) => {
		if (options.signal?.aborted) {
			resolve({ code: 130, out: "", err: "Command cancelled", ms: Date.now() - start });
			return;
		}
		const proc = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"] });
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
			finish({ code: 130, out, err: `${err}\nCommand cancelled`, ms: Date.now() - start });
		};
		const timer = setTimeout(() => {
			proc.kill("SIGKILL");
			finish({ code: 124, out, err: `${err}\nCommand timed out`, ms: Date.now() - start });
		}, options.timeoutMs);
		options.signal?.addEventListener("abort", onAbort, { once: true });
		proc.stdout.on("data", (chunk: Buffer) => {
			out += chunk.toString("utf8");
		});
		proc.stderr.on("data", (chunk: Buffer) => {
			err += chunk.toString("utf8");
		});
		if (options.input === undefined) proc.stdin.end();
		else proc.stdin.end(options.input);
		proc.on("error", (error) => finish({ code: 127, out, err: `${err}${error.message}`, ms: Date.now() - start }));
		proc.on("close", (code) => finish({ code: code ?? 1, out, err, ms: Date.now() - start }));
	});
}

function runtimeLimits(input?: RuntimeToolLimits): Required<RuntimeToolLimits> {
	return {
		maxFileBytes: input?.maxFileBytes ?? 1_000_000,
		maxScanBytes: input?.maxScanBytes ?? 5_000_000,
		maxEntries: input?.maxEntries ?? 10_000,
	};
}

function assertSize(size: number, max: number, label: string): void {
	if (size > max) throw new Error(`${label} exceeds limit: ${size} > ${max}`);
}

function workspacePath(path = "."): string {
	const value = path.trim() || ".";
	if (value.includes("\0")) throw new Error("path contains null byte");
	if (posix.isAbsolute(value)) throw new Error(`path escapes runtime root: ${path}`);
	const normalized = posix.normalize(value.replaceAll("\\", "/"));
	if (normalized === ".." || normalized.startsWith("../")) throw new Error(`path escapes runtime root: ${path}`);
	return normalized === "." ? "." : normalized.replace(/^\.\//, "");
}

function shellPath(path: string): string {
	return path === "." ? "." : `./${path}`;
}

function splitColumns(input: string, count: number): string[] {
	const out = input.split("\t");
	while (out.length < count) out.push("");
	if (out.length > count) return [...out.slice(0, count - 1), out.slice(count - 1).join("\t")];
	return out;
}

function match(value: string, pattern?: string): boolean {
	if (!pattern || pattern === "*" || pattern === "**/*") return true;
	const escaped = pattern
		.replace(/[.+^${}()|[\]\\]/g, "\\$&")
		.replace(/\*\*/g, "::STAR::")
		.replace(/\*/g, "[^/]*")
		.replace(/::STAR::/g, ".*");
	return new RegExp(`^${escaped}$`).test(value) || value.includes(pattern);
}

const READ_SCRIPT = `
set -eu
path=$1
max=$2
[ -f "$path" ] || { echo "not a file: $path" >&2; exit 1; }
size=$(wc -c < "$path" | tr -d ' ')
[ "$size" -le "$max" ] || { echo "$path exceeds limit: $size > $max" >&2; exit 1; }
printf '__HEYPI_FILE__\\n'
cat "$path"
`;

const WRITE_SCRIPT = `
set -eu
path=$1
dir=\${path%/*}
if [ "$dir" != "$path" ]; then mkdir -p -- "$dir"; fi
cat > "$path"
wc -c < "$path" | tr -d ' '
`;

const FIND_SCRIPT = `
set -eu
path=$1
max=$2
if [ -f "$path" ]; then
  printf '%s\\n' "\${path#./}"
  exit 0
fi
[ -d "$path" ] || { echo "not a file or directory: $path" >&2; exit 1; }
find "$path" -mindepth 1 | sed 's#^\\./##' | head -n "$max"
`;

const LS_SCRIPT = `
set -eu
path=$1
max=$2
[ -d "$path" ] || { echo "not a directory: $path" >&2; exit 1; }
find "$path" -mindepth 1 -maxdepth 1 | head -n "$max" | while IFS= read -r entry; do
  rel=\${entry#./}
  name=\${entry##*/}
  if [ -d "$entry" ]; then type=directory; elif [ -f "$entry" ]; then type=file; else type=other; fi
  if [ -f "$entry" ]; then size=$(wc -c < "$entry" | tr -d ' '); else size=0; fi
  printf '%s\\t%s\\t%s\\t%s\\n' "$name" "$rel" "$type" "$size"
done
`;

const GREP_SCRIPT = `
set -eu
path=$1
query=$2
max=$3
max_file=$4
max_scan=$5
max_entries=$6
files=/tmp/heypi-files-$$
out=/tmp/heypi-grep-$$
trap 'rm -f "$files" "$out"' EXIT
find "$path" -type f > "$files"
: > "$out"
scanned=0
entries=0
while IFS= read -r file; do
  entries=$((entries + 1))
  [ "$entries" -le "$max_entries" ] || break
  size=$(wc -c < "$file" | tr -d ' ')
  [ "$size" -le "$max_file" ] || { echo "$file exceeds limit: $size > $max_file" >&2; exit 1; }
  scanned=$((scanned + size))
  [ "$scanned" -le "$max_scan" ] || { echo "scan exceeds limit: $scanned > $max_scan" >&2; exit 1; }
  rel=\${file#./}
  awk -v query="$query" -v rel="$rel" 'index($0, query) { print rel "\\t" FNR "\\t" $0 }' "$file" >> "$out"
  [ "$(wc -l < "$out" | tr -d ' ')" -lt "$max" ] || break
done < "$files"
head -n "$max" "$out"
`;

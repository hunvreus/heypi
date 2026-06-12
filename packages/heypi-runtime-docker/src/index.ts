import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, posix } from "node:path";
import type {
	BashInput,
	BashResult,
	EditInput,
	EditResult,
	FindInput,
	FindResult,
	GrepHit,
	GrepInput,
	GrepResult,
	LsEntry,
	LsInput,
	LsResult,
	ReadInput,
	ReadResult,
	Runtime,
	RuntimeEvent,
	RuntimeEventHandler,
	RuntimeLogger,
	RuntimeProvider,
	RuntimeScope,
	RuntimeStatus,
	WriteInput,
	WriteResult,
} from "@hunvreus/heypi/runtime";
import { RuntimeStartupError } from "@hunvreus/heypi/runtime";

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
	labels?: Record<string, string>;
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
	private log: RuntimeLogger | undefined;

	constructor(private readonly config: DockerRuntimeConfig) {}

	get(scope: RuntimeScope): Runtime {
		const key = scope.path;
		const cached = this.scopes.get(key);
		if (cached) return cached.runtime();
		const next = new DockerScopeRuntime(scope, this.config, this.log);
		this.scopes.set(key, next);
		return next.runtime();
	}

	setLogger(logger: RuntimeLogger): void {
		this.log = logger;
		for (const scope of this.scopes.values()) scope.setLogger(logger);
	}

	status(scope?: RuntimeScope): RuntimeStatus[] {
		return this.selectScopes(scope).map((scope) => scope.status());
	}

	async stop(scope?: RuntimeScope): Promise<void> {
		await Promise.allSettled(this.selectScopes(scope).map((scope) => scope.stop("manual")));
	}

	async restart(scope?: RuntimeScope): Promise<void> {
		await Promise.allSettled(this.selectScopes(scope).map((scope) => scope.restart()));
	}

	async cleanup(): Promise<void> {
		const docker = this.config.docker ?? "docker";
		const runner = this.config.runner ?? runCommand;
		const prefix = this.config.prefix ?? "heypi";
		const listed = await runner(
			docker,
			[
				"ps",
				"-a",
				"--filter",
				"label=heypi.runtime=docker",
				"--filter",
				`label=heypi.prefix=${prefix}`,
				"--format",
				"{{.Names}}",
			],
			{ timeoutMs: 30_000 },
		);
		if (listed.code !== 0) throw new Error(listed.err.trim() || "Docker runtime cleanup failed");
		const containers = listed.out.split(/\r?\n/).filter(Boolean);
		for (const container of containers)
			await runner(docker, ["rm", "-f", container], { timeoutMs: 30_000 }).catch(() => undefined);
		this.log?.info("runtime.docker.cleanup", { prefix, containers: containers.length });
	}

	async close(): Promise<void> {
		await Promise.allSettled([...this.scopes.values()].map((scope) => scope.stop("close")));
		this.scopes.clear();
	}

	private selectScopes(scope: RuntimeScope | undefined): DockerScopeRuntime[] {
		if (!scope) return [...this.scopes.values()];
		const selected = this.scopes.get(scope.path);
		if (!selected) throw new Error(`unknown Docker runtime scope: ${scope.path}`);
		return [selected];
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
	private log: RuntimeLogger | undefined;
	private starting: Promise<string> | undefined;
	private container: string | undefined;
	private idleTimer: NodeJS.Timeout | undefined;
	private active = 0;
	private startedAt: number | undefined;
	private lastUsedAt: number | undefined;

	constructor(
		private readonly scope: RuntimeScope,
		private readonly config: DockerRuntimeConfig,
		log?: RuntimeLogger,
	) {
		this.docker = config.docker ?? "docker";
		this.image = config.image ?? "debian:bookworm-slim";
		this.workdir = config.workdir ?? "/workspace";
		this.timeoutMs = config.timeoutMs ?? 120_000;
		this.idleMs = config.idleMs === undefined ? 10 * 60 * 1000 : config.idleMs;
		this.limits = runtimeLimits(config.limits);
		this.runner = config.runner ?? runCommand;
		this.log = log;
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

	setLogger(logger: RuntimeLogger): void {
		this.log = logger;
	}

	status(): RuntimeStatus {
		return {
			name: "docker",
			scope: this.scope,
			root: this.scope.root,
			state: this.starting ? "starting" : this.container ? "running" : "stopped",
			id: this.container,
			startedAt: this.startedAt,
			lastUsedAt: this.lastUsedAt,
			idleMs: this.idleMs,
		};
	}

	async restart(): Promise<void> {
		await this.stop("restart");
		await this.ensureContainer();
	}

	async stop(reason = "manual"): Promise<void> {
		this.clearIdleTimer();
		const container = this.container ?? (this.starting ? await this.starting.catch(() => undefined) : undefined);
		this.container = undefined;
		this.starting = undefined;
		this.startedAt = undefined;
		if (container)
			await this.runner(this.docker, ["rm", "-f", container], { timeoutMs: 30_000 })
				.then(() => this.log?.info("runtime.docker.stop", this.fields({ container, reason })))
				.catch((error) =>
					this.log?.warn(
						"runtime.docker.stop_failed",
						this.fields({ container, reason, error: errorMessage(error) }),
					),
				);
	}

	private async ensureContainer(signal?: AbortSignal, runtimeEvents?: RuntimeEventHandler): Promise<string> {
		if (this.container) {
			if (await this.containerRunning(this.container, signal)) {
				this.emit(runtimeEvents, { kind: "reuse", id: this.container });
				this.log?.debug("runtime.docker.reuse", this.fields({ container: this.container }));
				return this.container;
			}
			const stale = this.container;
			this.container = undefined;
			this.startedAt = undefined;
			this.log?.warn("runtime.docker.unhealthy", this.fields({ container: stale }));
			await this.runner(this.docker, ["rm", "-f", stale], { timeoutMs: 30_000, signal }).catch(() => undefined);
		}
		if (this.starting) {
			this.emit(runtimeEvents, {
				kind: "starting",
				id: this.containerName(),
			});
			return await this.starting;
		}
		this.starting = this.startContainer(signal, runtimeEvents);
		try {
			this.container = await this.starting;
			this.scheduleIdleStop();
			return this.container;
		} finally {
			this.starting = undefined;
		}
	}

	private async startContainer(signal?: AbortSignal, runtimeEvents?: RuntimeEventHandler): Promise<string> {
		await mkdir(this.scope.root, { recursive: true });
		const name = this.containerName();
		const inspect = await this.runner(this.docker, ["inspect", "-f", "{{.State.Running}}", name], {
			timeoutMs: 10_000,
			signal,
		}).catch(() => undefined);
		if (inspect?.code === 0 && inspect.out.trim() === "true") {
			this.startedAt = Date.now();
			this.lastUsedAt = this.startedAt;
			this.log?.info("runtime.docker.recover", this.fields({ container: name, image: this.image }));
			return name;
		}
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
		for (const [key, value] of Object.entries(this.labels())) args.push("--label", `${key}=${value}`);
		if (this.config.user) args.push("--user", this.config.user);
		const envFile = await dockerEnvFile(this.config.env);
		if (envFile) args.push("--env-file", envFile.path);
		args.push(...(this.config.extraRunArgs ?? []), this.image, "sleep", "infinity");

		this.emit(runtimeEvents, {
			kind: "starting",
			id: name,
		});
		this.log?.info("runtime.docker.starting", this.fields({ container: name, image: this.image }));
		let started: BashResult;
		try {
			started = await this.runner(this.docker, args, { timeoutMs: this.timeoutMs, signal });
		} finally {
			await envFile?.cleanup();
		}
		if (started.code !== 0) {
			const detail = started.err.trim() || started.out.trim() || `exit ${started.code}`;
			this.emit(runtimeEvents, { kind: "start_failed", id: name, message: detail });
			this.log?.error(
				"runtime.docker.start_failed",
				this.fields({ container: name, image: this.image, error: detail }),
			);
			throw new RuntimeStartupError(`Docker runtime failed to start container ${name}: ${detail}`);
		}
		this.startedAt = Date.now();
		this.lastUsedAt = this.startedAt;
		this.emit(runtimeEvents, { kind: "start", id: name });
		this.log?.info("runtime.docker.start", this.fields({ container: name, image: this.image }));
		return name;
	}

	private async containerRunning(container: string, signal?: AbortSignal): Promise<boolean> {
		const inspect = await this.runner(this.docker, ["inspect", "-f", "{{.State.Running}}", container], {
			timeoutMs: 10_000,
			signal,
		}).catch(() => undefined);
		return inspect?.code === 0 && inspect.out.trim() === "true";
	}

	private containerName(): string {
		const hash = createHash("sha256").update(this.scope.path).digest("hex").slice(0, 16);
		const prefix = this.config.prefix ?? "heypi";
		return `${prefix}-${hash}`;
	}

	private scheduleIdleStop(): void {
		this.clearIdleTimer();
		if (this.active > 0 || !this.container) return;
		if (!this.idleMs || this.idleMs <= 0) return;
		this.idleTimer = setTimeout(() => {
			if (this.active > 0 || !this.container) return;
			this.log?.info("runtime.docker.idle_stop", this.fields({ idleMs: this.idleMs }));
			void this.stop("idle");
		}, this.idleMs);
		this.idleTimer.unref?.();
	}

	private clearIdleTimer(): void {
		if (!this.idleTimer) return;
		clearTimeout(this.idleTimer);
		this.idleTimer = undefined;
	}

	private async bash({ command, timeoutMs, signal, runtimeEvents }: BashInput): Promise<BashResult> {
		this.beginUse();
		try {
			const container = await this.ensureContainer(signal, runtimeEvents);
			this.log?.debug("runtime.docker.exec", this.fields({ container, op: "bash" }));
			const result = await this.runner(this.docker, ["exec", "-i", container, "bash", "-lc", command], {
				timeoutMs: timeoutMs ?? this.timeoutMs,
				signal,
			});
			if (shouldResetContainer(result)) {
				this.log?.warn("runtime.docker.exec_failed", this.fields({ container, op: "bash", code: result.code }));
				await this.stop(result.code === 124 ? "timeout" : "exec_failed");
				return result;
			}
			return result;
		} finally {
			this.endUse();
		}
	}

	private async read({ path, offset, limit, signal, runtimeEvents }: ReadInput): Promise<ReadResult> {
		const normalized = workspacePath(path);
		const out = await this.sh(READ_SCRIPT, [shellPath(normalized), String(this.limits.maxFileBytes)], {
			signal,
			runtimeEvents,
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

	private async write({ path, content, runtimeEvents }: WriteInput): Promise<WriteResult> {
		const normalized = workspacePath(path);
		assertSize(Buffer.byteLength(content), this.limits.maxFileBytes, normalized);
		const out = await this.sh(WRITE_SCRIPT, [shellPath(normalized)], { input: content, runtimeEvents });
		return { path: normalized, bytes: Number(out.trim()) || Buffer.byteLength(content) };
	}

	private async edit({ path, oldText, newText, replaceAll, runtimeEvents }: EditInput): Promise<EditResult> {
		const current = await this.read({ path, runtimeEvents });
		const count = current.text.split(oldText).length - 1;
		if (count === 0) throw new Error(`text not found in ${current.path}`);
		if (!replaceAll && count > 1) throw new Error(`text is not unique in ${current.path}`);
		const next = replaceAll ? current.text.replaceAll(oldText, newText) : current.text.replace(oldText, newText);
		await this.write({ path: current.path, content: next, runtimeEvents });
		return { path: current.path, replacements: replaceAll ? count : 1 };
	}

	private async grep({ query, path = ".", maxResults = 100, signal, runtimeEvents }: GrepInput): Promise<GrepResult> {
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
			{ signal, runtimeEvents },
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
		runtimeEvents,
	}: FindInput): Promise<FindResult> {
		const limit = Math.min(Math.max(1, maxResults), this.limits.maxEntries);
		const out = await this.sh(FIND_SCRIPT, [shellPath(workspacePath(path)), String(limit)], {
			signal,
			runtimeEvents,
		});
		return {
			paths: out
				.split("\n")
				.filter((entry) => entry && match(entry, pattern))
				.slice(0, maxResults),
		};
	}

	private async ls({ path = ".", signal, runtimeEvents }: LsInput): Promise<LsResult> {
		const out = await this.sh(LS_SCRIPT, [shellPath(workspacePath(path)), String(this.limits.maxEntries)], {
			signal,
			runtimeEvents,
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
		options: {
			signal?: AbortSignal;
			input?: string | Buffer;
			timeoutMs?: number;
			runtimeEvents?: RuntimeEventHandler;
		} = {},
	): Promise<string> {
		this.beginUse();
		try {
			const container = await this.ensureContainer(options.signal, options.runtimeEvents);
			const result = await this.runner(
				this.docker,
				["exec", "-i", container, "sh", "-c", script, "heypi", ...args],
				{
					timeoutMs: options.timeoutMs ?? this.timeoutMs,
					signal: options.signal,
					input: options.input,
				},
			);
			if (result.code !== 0) {
				if (shouldResetContainer(result)) {
					this.log?.warn("runtime.docker.exec_failed", this.fields({ container, op: "tool", code: result.code }));
					await this.stop(result.code === 124 ? "timeout" : "exec_failed");
				}
				throw new Error(result.err.trim() || result.out.trim() || "Docker runtime command failed");
			}
			return result.out;
		} finally {
			this.endUse();
		}
	}

	private beginUse(): void {
		this.clearIdleTimer();
		this.active++;
	}

	private endUse(): void {
		if (this.active <= 0) this.log?.warn("runtime.docker.active_underflow", this.fields());
		this.active = Math.max(0, this.active - 1);
		this.lastUsedAt = Date.now();
		this.scheduleIdleStop();
	}

	private labels(): Record<string, string> {
		return {
			"heypi.runtime": "docker",
			"heypi.prefix": this.config.prefix ?? "heypi",
			"heypi.scope.level": this.scope.level ?? "",
			"heypi.scope.key": this.scope.key,
			"heypi.scope.path": this.scope.path,
			...this.config.labels,
		};
	}

	private fields(extra: Record<string, unknown> = {}): Record<string, unknown> {
		return {
			runtime: "docker",
			scope: this.scope.path,
			level: this.scope.level,
			root: this.scope.root,
			...extra,
		};
	}

	private emit(
		runtimeEvents: RuntimeEventHandler | undefined,
		event: Omit<RuntimeEvent, "runtime" | "scope" | "root">,
	): void {
		if (!runtimeEvents) return;
		void Promise.resolve(
			runtimeEvents({
				runtime: "docker",
				scope: this.scope,
				root: this.scope.root,
				...event,
			}),
		).catch(() => undefined);
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

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

async function dockerEnvFile(
	env: Record<string, string> | undefined,
): Promise<{ path: string; cleanup: () => Promise<void> } | undefined> {
	const entries = Object.entries(env ?? {});
	if (!entries.length) return undefined;
	const dir = await mkdtemp(join(tmpdir(), "heypi-docker-env-"));
	const path = join(dir, "env");
	const lines = entries.map(([key, value]) => dockerEnvLine(key, value));
	await writeFile(path, `${lines.join("\n")}\n`, { mode: 0o600 });
	return { path, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

function dockerEnvLine(key: string, value: string): string {
	if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new Error(`invalid Docker env key: ${key}`);
	if (/[\0\r\n]/u.test(value)) throw new Error(`Docker env value contains unsupported newline or null byte: ${key}`);
	return `${key}=${value}`;
}

function shouldResetContainer(result: BashResult): boolean {
	const text = `${result.err}\n${result.out}`;
	return (
		/\b(Command timed out|Command cancelled|No such container|is not running|Cannot connect to the Docker daemon)\b/i.test(
			text,
		) || result.code === 125
	);
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

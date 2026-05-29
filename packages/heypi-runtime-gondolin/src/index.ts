import { mkdir } from "node:fs/promises";
import { posix } from "node:path";
import {
	createHttpHooks,
	type ExecOptions,
	type ExecResult,
	RealFSProvider,
	type SecretDefinition,
	VM,
	type VMOptions,
} from "@earendil-works/gondolin";
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

export type GondolinSecret = {
	value: string;
	hosts: string[];
};

export type RuntimeToolLimits = {
	maxFileBytes?: number;
	maxScanBytes?: number;
	maxEntries?: number;
};

export type GondolinRuntimeConfig = {
	workdir?: string;
	env?: Record<string, string>;
	secrets?: Record<string, GondolinSecret>;
	mounts?: Record<string, string>;
	vmOptions?: Omit<VMOptions, "env" | "httpHooks" | "sessionLabel" | "vfs">;
	sessionLabel?: string | ((scope: RuntimeScope) => string);
	timeoutMs?: number;
	idleMs?: number | false;
	limits?: RuntimeToolLimits;
	factory?: GondolinVmFactory;
};

export type GondolinVmFactory = (options: VMOptions) => Promise<GondolinVm>;

export type GondolinVm = {
	id?: string;
	exec(command: string | string[], options?: ExecOptions): PromiseLike<ExecResult>;
	close(): Promise<void>;
};

/** Creates a Gondolin-backed heypi runtime provider with one warm VM per runtime scope. */
export function gondolinRuntime(config: GondolinRuntimeConfig = {}): RuntimeProvider {
	return new GondolinRuntimeProvider(config);
}

class GondolinRuntimeProvider implements RuntimeProvider {
	private readonly scopes = new Map<string, GondolinScopeRuntime>();
	private log: RuntimeLogger | undefined;

	constructor(private readonly config: GondolinRuntimeConfig) {}

	get(scope: RuntimeScope): Runtime {
		const key = scope.path;
		const cached = this.scopes.get(key);
		if (cached) return cached.runtime();
		const next = new GondolinScopeRuntime(scope, this.config, this.log);
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
		await this.stop();
		this.log?.info("runtime.gondolin.cleanup", { scopes: this.scopes.size });
	}

	async close(): Promise<void> {
		await Promise.allSettled([...this.scopes.values()].map((scope) => scope.stop("close")));
		this.scopes.clear();
	}

	private selectScopes(scope: RuntimeScope | undefined): GondolinScopeRuntime[] {
		if (!scope) return [...this.scopes.values()];
		const selected = this.scopes.get(scope.path);
		if (!selected) throw new Error(`unknown Gondolin runtime scope: ${scope.path}`);
		return [selected];
	}
}

class GondolinScopeRuntime {
	private readonly workdir: string;
	private readonly timeoutMs: number;
	private readonly idleMs: number | false;
	private readonly limits: Required<RuntimeToolLimits>;
	private log: RuntimeLogger | undefined;
	private vm: GondolinVm | undefined;
	private starting: Promise<GondolinVm> | undefined;
	private idleTimer: NodeJS.Timeout | undefined;
	private active = 0;
	private startedAt: number | undefined;
	private lastUsedAt: number | undefined;

	constructor(
		private readonly scope: RuntimeScope,
		private readonly config: GondolinRuntimeConfig,
		log?: RuntimeLogger,
	) {
		this.workdir = config.workdir ?? "/workspace";
		this.timeoutMs = config.timeoutMs ?? 120_000;
		this.idleMs = config.idleMs === undefined ? 10 * 60 * 1000 : config.idleMs;
		this.limits = runtimeLimits(config.limits);
		this.log = log;
	}

	runtime(): Runtime {
		return {
			name: "gondolin",
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
			name: "gondolin",
			scope: this.scope,
			root: this.scope.root,
			state: this.starting ? "starting" : this.vm ? "running" : "stopped",
			id: this.vm?.id,
			startedAt: this.startedAt,
			lastUsedAt: this.lastUsedAt,
			idleMs: this.idleMs,
		};
	}

	async restart(): Promise<void> {
		await this.stop("restart");
		await this.ensureVm();
	}

	async stop(reason = "manual"): Promise<void> {
		this.clearIdleTimer();
		const vm = this.vm ?? (this.starting ? await this.starting.catch(() => undefined) : undefined);
		this.vm = undefined;
		this.starting = undefined;
		this.startedAt = undefined;
		if (vm) {
			await vm
				.close()
				.then(() => this.log?.info("runtime.gondolin.stop", this.fields({ vm: vm.id, reason })))
				.catch((error) =>
					this.log?.warn(
						"runtime.gondolin.stop_failed",
						this.fields({ vm: vm.id, reason, error: errorMessage(error) }),
					),
				);
		}
	}

	private async ensureVm(runtimeEvents?: RuntimeEventHandler): Promise<GondolinVm> {
		if (this.vm) {
			this.emit(runtimeEvents, { kind: "reuse", id: this.vm.id });
			this.log?.debug("runtime.gondolin.reuse", this.fields({ vm: this.vm.id }));
			return this.vm;
		}
		if (this.starting) {
			this.emit(runtimeEvents, { kind: "starting" });
			return await this.starting;
		}
		this.starting = this.startVm(runtimeEvents);
		try {
			this.vm = await this.starting;
			this.startedAt = Date.now();
			this.lastUsedAt = this.startedAt;
			this.log?.info("runtime.gondolin.start", this.fields({ vm: this.vm.id }));
			this.scheduleIdleStop();
			return this.vm;
		} finally {
			this.starting = undefined;
		}
	}

	private async startVm(runtimeEvents?: RuntimeEventHandler): Promise<GondolinVm> {
		await mkdir(this.scope.root, { recursive: true });
		const secretConfig = resolveSecretEnvironment(this.config);
		const mounts: Record<string, RealFSProvider> = {
			[this.workdir]: new RealFSProvider(this.scope.root),
		};
		for (const [guestPath, hostPath] of Object.entries(this.config.mounts ?? {})) {
			mounts[guestPath] = new RealFSProvider(hostPath);
		}
		const factory = this.config.factory ?? ((options: VMOptions) => VM.create(options));
		this.emit(runtimeEvents, { kind: "starting" });
		this.log?.info("runtime.gondolin.starting", this.fields());
		try {
			const vm = await factory({
				...(this.config.vmOptions ?? {}),
				sessionLabel: sessionLabel(this.config, this.scope),
				env: { ...(this.config.env ?? {}), ...(secretConfig.env ?? {}) },
				httpHooks: secretConfig.httpHooks,
				vfs: { mounts },
			});
			this.emit(runtimeEvents, { kind: "start", id: vm.id });
			return vm;
		} catch (error) {
			const detail = errorMessage(error);
			this.emit(runtimeEvents, { kind: "start_failed", message: detail });
			this.log?.error("runtime.gondolin.start_failed", this.fields({ error: detail }));
			throw new RuntimeStartupError(`Gondolin runtime failed to start VM: ${detail}`);
		}
	}

	private scheduleIdleStop(): void {
		this.clearIdleTimer();
		if (this.active > 0 || !this.vm) return;
		if (!this.idleMs || this.idleMs <= 0) return;
		this.idleTimer = setTimeout(() => {
			if (this.active > 0 || !this.vm) return;
			this.log?.info("runtime.gondolin.idle_stop", this.fields({ idleMs: this.idleMs }));
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
			const vm = await this.ensureVm(runtimeEvents);
			this.log?.debug("runtime.gondolin.exec", this.fields({ vm: vm.id, op: "bash" }));
			const result = await execWithTimeout(vm, command, {
				cwd: this.workdir,
				timeoutMs: timeoutMs ?? this.timeoutMs,
				signal,
			}).catch(async (error) => {
				this.log?.warn(
					"runtime.gondolin.exec_failed",
					this.fields({ vm: vm.id, op: "bash", error: errorMessage(error) }),
				);
				await this.stop("exec_failed");
				throw error;
			});
			if (shouldResetVm(result)) {
				this.log?.warn("runtime.gondolin.exec_failed", this.fields({ vm: vm.id, op: "bash", code: result.code }));
				await this.stop(result.code === 124 ? "timeout" : "cancelled");
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
		const out = await this.sh(WRITE_SCRIPT, [shellPath(normalized)], { stdin: content, runtimeEvents });
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
		argv: string[],
		options: {
			signal?: AbortSignal;
			stdin?: string | Buffer;
			timeoutMs?: number;
			runtimeEvents?: RuntimeEventHandler;
		} = {},
	): Promise<string> {
		this.beginUse();
		try {
			const vm = await this.ensureVm(options.runtimeEvents);
			const result = await execWithTimeout(vm, script, {
				argv,
				cwd: this.workdir,
				timeoutMs: options.timeoutMs ?? this.timeoutMs,
				signal: options.signal,
				stdin: options.stdin,
			}).catch(async (error) => {
				this.log?.warn(
					"runtime.gondolin.exec_failed",
					this.fields({ vm: vm.id, op: "tool", error: errorMessage(error) }),
				);
				await this.stop("exec_failed");
				throw error;
			});
			if (result.code !== 0) {
				if (shouldResetVm(result)) {
					this.log?.warn(
						"runtime.gondolin.exec_failed",
						this.fields({ vm: vm.id, op: "tool", code: result.code }),
					);
					await this.stop(result.code === 124 ? "timeout" : "cancelled");
				}
				throw new Error(result.err.trim() || result.out.trim() || "Gondolin runtime command failed");
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
		if (this.active <= 0) this.log?.warn("runtime.gondolin.active_underflow", this.fields());
		this.active = Math.max(0, this.active - 1);
		this.lastUsedAt = Date.now();
		this.scheduleIdleStop();
	}

	private fields(extra: Record<string, unknown> = {}): Record<string, unknown> {
		return {
			runtime: "gondolin",
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
				runtime: "gondolin",
				scope: this.scope,
				root: this.scope.root,
				...event,
			}),
		).catch(() => undefined);
	}
}

function resolveSecretEnvironment(config: GondolinRuntimeConfig): {
	env?: Record<string, string>;
	httpHooks?: ReturnType<typeof createHttpHooks>["httpHooks"];
} {
	const entries = Object.entries(config.secrets ?? {});
	if (entries.length === 0) return {};
	const secrets: Record<string, SecretDefinition> = {};
	for (const [name, secret] of entries) {
		if (!secret.value.trim()) throw new Error(`Gondolin secret ${name} must have a value`);
		if (secret.hosts.length === 0) throw new Error(`Gondolin secret ${name} must declare at least one host`);
		secrets[name] = { value: secret.value, hosts: [...secret.hosts] };
	}
	const { env, httpHooks } = createHttpHooks({ allowedHosts: ["*"], secrets });
	return { env, httpHooks };
}

function sessionLabel(config: GondolinRuntimeConfig, scope: RuntimeScope): string {
	if (typeof config.sessionLabel === "function") return config.sessionLabel(scope);
	return config.sessionLabel ?? `heypi ${scope.path}`;
}

async function execWithTimeout(
	vm: GondolinVm,
	command: string,
	input: { cwd: string; timeoutMs: number; signal?: AbortSignal; argv?: string[]; stdin?: string | Buffer },
): Promise<BashResult> {
	const start = Date.now();
	const controller = new AbortController();
	const abort = () => controller.abort();
	const timeout = setTimeout(abort, input.timeoutMs);
	input.signal?.addEventListener("abort", abort, { once: true });
	try {
		if (input.signal?.aborted) controller.abort();
		const result = await vm.exec(command, {
			argv: input.argv,
			cwd: input.cwd,
			signal: controller.signal,
			stdin: input.stdin,
		});
		return { code: result.exitCode, out: result.stdout, err: result.stderr, ms: Date.now() - start };
	} catch (error) {
		if (controller.signal.aborted) {
			return {
				code: input.signal?.aborted ? 130 : 124,
				out: "",
				err: input.signal?.aborted ? "Command cancelled" : "Command timed out",
				ms: Date.now() - start,
			};
		}
		throw error;
	} finally {
		clearTimeout(timeout);
		input.signal?.removeEventListener("abort", abort);
	}
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

function shouldResetVm(result: BashResult): boolean {
	return /\b(Command timed out|Command cancelled)\b/i.test(`${result.err}\n${result.out}`);
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

export type RuntimeName = "just-bash" | "guarded-bash" | "host-bash";

export type RuntimeEventKind = "starting" | "start" | "start_failed" | "reuse" | "stop" | "idle_stop" | "exec_failed";

export type RuntimeEvent = {
	kind: RuntimeEventKind;
	runtime: string;
	message?: string;
	scope?: RuntimeScope;
	root?: string;
	id?: string;
};

export type RuntimeEventHandler = (event: RuntimeEvent) => void | Promise<void>;

type RuntimeEventInput = { runtimeEvents?: RuntimeEventHandler };

export type BashInput = { command: string; timeoutMs?: number; signal?: AbortSignal } & RuntimeEventInput;
export type BashResult = { code: number; out: string; err: string; ms: number };

export type ReadInput = { path: string; offset?: number; limit?: number; signal?: AbortSignal } & RuntimeEventInput;
export type ReadResult = { text: string; path: string; lines?: number };

export type WriteInput = { path: string; content: string } & RuntimeEventInput;
export type WriteResult = { path: string; bytes: number };

export type EditInput = { path: string; oldText: string; newText: string; replaceAll?: boolean } & RuntimeEventInput;
export type EditResult = { path: string; replacements: number };

export type GrepInput = { query: string; path?: string; maxResults?: number; signal?: AbortSignal } & RuntimeEventInput;
export type GrepHit = { path: string; line: number; text: string };
export type GrepResult = { hits: GrepHit[] };

export type FindInput = {
	pattern?: string;
	path?: string;
	maxResults?: number;
	signal?: AbortSignal;
} & RuntimeEventInput;
export type FindResult = { paths: string[] };

export type LsInput = { path?: string; signal?: AbortSignal } & RuntimeEventInput;
export type LsEntry = { name: string; path: string; type: "file" | "directory" | "other"; size?: number };
export type LsResult = { entries: LsEntry[] };

export type Runtime = {
	name: string;
	root: string;
	bash?(input: BashInput): Promise<BashResult>;
	read?(input: ReadInput): Promise<ReadResult>;
	write?(input: WriteInput): Promise<WriteResult>;
	edit?(input: EditInput): Promise<EditResult>;
	grep?(input: GrepInput): Promise<GrepResult>;
	find?(input: FindInput): Promise<FindResult>;
	ls?(input: LsInput): Promise<LsResult>;
};

export type RuntimeScope = {
	level?: string;
	key: string;
	path: string;
	root: string;
};

export type RuntimeLogger = {
	debug(event: string, input?: Record<string, unknown>): void;
	info(event: string, input?: Record<string, unknown>): void;
	warn(event: string, input?: Record<string, unknown>): void;
	error(event: string, input?: Record<string, unknown>): void;
};

export type RuntimeStatus = {
	name: string;
	scope: RuntimeScope;
	root: string;
	state: "starting" | "running" | "stopped";
	id?: string;
	startedAt?: number;
	lastUsedAt?: number;
	idleMs?: number | false;
};

export type RuntimeProvider = {
	get(scope: RuntimeScope): Runtime;
	setLogger?(logger: RuntimeLogger): void;
	status?(scope?: RuntimeScope): RuntimeStatus[] | Promise<RuntimeStatus[]>;
	stop?(scope?: RuntimeScope): void | Promise<void>;
	restart?(scope?: RuntimeScope): void | Promise<void>;
	cleanup?(): void | Promise<void>;
	close?(): void | Promise<void>;
};

export type RuntimeName = "just-bash" | "docker-bash" | "guarded-bash" | "host-bash";

export type Capabilities = {
	bash?: boolean;
	read?: boolean;
	write?: boolean;
	edit?: boolean;
	grep?: boolean;
	find?: boolean;
	ls?: boolean;
};

type BashInput = { command: string; timeoutMs?: number; signal?: AbortSignal };
export type BashResult = { code: number; out: string; err: string; ms: number };

type ReadInput = { path: string; offset?: number; limit?: number; signal?: AbortSignal };
type ReadResult = { text: string; path: string; lines?: number };

type WriteInput = { path: string; content: string };
type WriteResult = { path: string; bytes: number };

type EditInput = { path: string; oldText: string; newText: string; replaceAll?: boolean };
type EditResult = { path: string; replacements: number };

type GrepInput = { query: string; path?: string; maxResults?: number; signal?: AbortSignal };
export type GrepHit = { path: string; line: number; text: string };
type GrepResult = { hits: GrepHit[] };

type FindInput = { pattern?: string; path?: string; maxResults?: number; signal?: AbortSignal };
type FindResult = { paths: string[] };

type LsInput = { path?: string; signal?: AbortSignal };
export type LsEntry = { name: string; path: string; type: "file" | "directory" | "other"; size?: number };
type LsResult = { entries: LsEntry[] };

export type Runtime = {
	name: RuntimeName;
	root: string;
	capabilities: Capabilities;
	bash?(input: BashInput): Promise<BashResult>;
	read?(input: ReadInput): Promise<ReadResult>;
	write?(input: WriteInput): Promise<WriteResult>;
	edit?(input: EditInput): Promise<EditResult>;
	grep?(input: GrepInput): Promise<GrepResult>;
	find?(input: FindInput): Promise<FindResult>;
	ls?(input: LsInput): Promise<LsResult>;
};

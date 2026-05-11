export type RuntimeName = "just-bash" | "guarded-bash" | "host-bash";

export type Capabilities = {
	bash?: boolean;
	read?: boolean;
	write?: boolean;
	edit?: boolean;
	grep?: boolean;
	find?: boolean;
	ls?: boolean;
};

export type BashInput = { command: string; timeoutMs?: number; signal?: AbortSignal };
export type BashResult = { code: number; out: string; err: string; ms: number };

export type ReadInput = { path: string; offset?: number; limit?: number };
export type ReadResult = { text: string; path: string; lines?: number };

export type WriteInput = { path: string; content: string };
export type WriteResult = { path: string; bytes: number };

export type EditInput = { path: string; oldText: string; newText: string; replaceAll?: boolean };
export type EditResult = { path: string; replacements: number };

export type GrepInput = { query: string; path?: string; maxResults?: number };
export type GrepHit = { path: string; line: number; text: string };
export type GrepResult = { hits: GrepHit[] };

export type FindInput = { pattern?: string; path?: string; maxResults?: number };
export type FindResult = { paths: string[] };

export type LsInput = { path?: string };
export type LsEntry = { name: string; path: string; type: "file" | "directory" | "other"; size?: number };
export type LsResult = { entries: LsEntry[] };

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

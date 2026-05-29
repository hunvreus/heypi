import { message as errorMessage, type Logger } from "../core/log.js";
import { chunkText } from "../render/chunk.js";

export type ReplyStreamConfig = {
	enabled?: boolean;
	intervalMs?: number;
	minChars?: number;
	maxFailures?: number;
};

export type ReplyStreamOption = boolean | ReplyStreamConfig;

export type ReplyStream = {
	update(text: string): Promise<void>;
	finalize(text?: string): Promise<void>;
	stop(): Promise<void>;
	sent?(): boolean;
	complete?(): boolean;
	clear?(): Promise<void>;
};

export type ReplyStreamTransport = {
	limit: number;
	create(text: string): Promise<string>;
	edit(id: string, text: string): Promise<void>;
	delete?(id: string): Promise<void>;
};

type Chunk = {
	id: string;
	text: string;
};

/** Provider-neutral draft reply edited at a bounded cadence. */
export class DraftReplyStream implements ReplyStream {
	private readonly intervalMs: number;
	private readonly minChars: number;
	private readonly maxFailures: number;
	private chunks: Chunk[] = [];
	private pending = "";
	private displayed = "";
	private timer: ReturnType<typeof setTimeout> | undefined;
	private inFlight: Promise<void> = Promise.resolve();
	private stopped = false;
	private completed = false;
	private failures = 0;
	private lastFlush = 0;

	constructor(
		private readonly transport: ReplyStreamTransport,
		config: ReplyStreamOption = {},
		private readonly logger?: Logger,
		private readonly context: Record<string, unknown> = {},
	) {
		const options = config === true ? {} : config || {};
		this.intervalMs = options.intervalMs ?? 1000;
		this.minChars = options.minChars ?? 40;
		this.maxFailures = options.maxFailures ?? 3;
	}

	async update(text: string): Promise<void> {
		if (this.stopped) return;
		this.pending = text;
		if (!this.shouldFlush(false)) {
			this.schedule();
			return;
		}
		await this.enqueue(false);
	}

	async finalize(text?: string): Promise<void> {
		if (this.stopped) {
			await this.inFlight;
			return;
		}
		if (text !== undefined) this.pending = text;
		this.stopped = true;
		this.cancel();
		await this.enqueue(true);
		await this.inFlight;
	}

	async stop(): Promise<void> {
		this.stopped = true;
		this.cancel();
		await this.inFlight;
	}

	async clear(): Promise<void> {
		await this.stop();
		const chunks = this.chunks.splice(0);
		for (const chunk of chunks) {
			await this.transport.delete?.(chunk.id).catch(() => undefined);
		}
		this.displayed = "";
	}

	sent(): boolean {
		return this.chunks.length > 0;
	}

	complete(): boolean {
		return this.completed;
	}

	private shouldFlush(finalize: boolean): boolean {
		if (finalize) return true;
		if (!this.pending.trim()) return false;
		if (this.pending.length - this.displayed.length < this.minChars) return false;
		return Date.now() - this.lastFlush >= this.intervalMs;
	}

	private schedule(): void {
		if (this.timer) return;
		const wait = Math.max(0, this.intervalMs - (Date.now() - this.lastFlush));
		this.timer = setTimeout(() => {
			this.timer = undefined;
			void this.enqueue(false);
		}, wait);
	}

	private cancel(): void {
		if (this.timer) clearTimeout(this.timer);
		this.timer = undefined;
	}

	private async enqueue(finalize: boolean): Promise<void> {
		this.cancel();
		this.inFlight = this.inFlight.then(() => this.flush(finalize));
		await this.inFlight;
	}

	private async flush(finalize: boolean): Promise<void> {
		const text = this.pending.trim();
		if (!text || (!finalize && text === this.displayed)) return;
		if (!finalize && text.length - this.displayed.length < this.minChars) {
			this.schedule();
			return;
		}
		try {
			const parts = chunkText(text, this.transport.limit).filter((part) => part.trim());
			if (parts.length === 0) return;
			for (let index = 0; index < parts.length; index++) {
				const part = parts[index];
				const existing = this.chunks[index];
				if (!existing) {
					const id = await this.transport.create(part);
					this.chunks.push({ id, text: part });
					continue;
				}
				if (existing.text !== part) {
					await this.transport.edit(existing.id, part);
					existing.text = part;
				}
			}
			if (finalize && this.transport.delete) {
				const extras = this.chunks.splice(parts.length);
				for (const chunk of extras) await this.transport.delete(chunk.id).catch(() => undefined);
			}
			this.displayed = text;
			this.lastFlush = Date.now();
			this.failures = 0;
			if (finalize) this.completed = true;
		} catch (error) {
			this.failures++;
			this.logger?.warn("reply_stream.failed", {
				...this.context,
				failures: this.failures,
				error: errorMessage(error),
			});
			if (this.failures >= this.maxFailures) {
				this.stopped = true;
				this.cancel();
			}
		}
	}
}

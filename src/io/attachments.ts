import { randomUUID } from "node:crypto";
import { mkdir, stat, writeFile } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import type { AttachmentConfig } from "../config.js";
import type { ReplyAttachment } from "../core/types.js";
import { hostPath, virtualPath } from "../runtime/path.js";
import type { Runtime } from "../runtime/types.js";

export type Attachment = {
	name: string;
	path: string;
	mimeType?: string;
	size?: number;
	provider?: string;
	id?: string;
	sourceUrl?: string;
};

export type AttachmentSaveInput = {
	provider: string;
	id?: string;
	name: string;
	data: Uint8Array;
	mimeType?: string;
	sourceUrl?: string;
	messageId?: string;
};

export interface AttachmentStore {
	maxBytes?: number;
	save(input: AttachmentSaveInput): Promise<Attachment>;
	resolve(input: ReplyAttachment): Promise<ResolvedAttachment>;
}

export type ResolvedAttachment = {
	path: string;
	name: string;
	mimeType?: string;
	size: number;
};

/** Creates a workspace-backed attachment store. Writes files under `incoming/`. */
export function runtimeAttachments(runtime: Runtime, config: AttachmentConfig = {}): AttachmentStore {
	const maxBytes = config.maxBytes ?? 25_000_000;
	return {
		maxBytes,
		async save(input): Promise<Attachment> {
			if (input.data.byteLength > maxBytes) {
				throw new Error(`attachment exceeds limit: ${input.data.byteLength} > ${maxBytes}`);
			}
			const name = safeName(input.name);
			const message = safeSegment(input.messageId ?? "unknown");
			const provider = safeSegment(input.provider);
			const id = safeSegment(input.id ?? randomUUID());
			const relative = join("incoming", provider, message, `${id}-${name}`);
			const full = hostPath(runtime.root, relative);
			await mkdir(hostPath(runtime.root, join("incoming", provider, message)), { recursive: true });
			await writeFile(full, input.data);
			return compact({
				name,
				path: runtime.name === "just-bash" ? virtualPath(relative) : relative,
				mimeType: input.mimeType,
				size: input.data.byteLength,
				provider: input.provider,
				id: input.id,
				sourceUrl: input.sourceUrl,
			});
		},
		async resolve(input): Promise<ResolvedAttachment> {
			const full = hostPath(runtime.root, input.path);
			const info = await stat(full);
			if (!info.isFile()) throw new Error(`attachment is not a file: ${input.path}`);
			return compactResolved({
				path: full,
				name: safeName(input.name ?? (basename(input.path) || "attachment")),
				mimeType: input.mimeType,
				size: info.size,
			});
		},
	};
}

export function attachmentPrompt(text: string, attachments?: Attachment[]): string {
	const body = text.trim();
	if (!attachments?.length) return body;
	const lines = attachments.map((file) => `- ${file.name}: ${file.path}${details(file)}`);
	return [body, "Attachments:", ...lines].filter(Boolean).join("\n");
}

function details(file: Attachment): string {
	const values = [file.mimeType, file.size === undefined ? undefined : `${file.size} bytes`].filter(Boolean);
	return values.length ? ` (${values.join(", ")})` : "";
}

function safeName(input: string): string {
	const fallback = "attachment";
	const base = basename(input.trim() || fallback)
		.replace(/[^\w.-]+/g, "_")
		.replace(/^_+|_+$/g, "");
	const name = base || fallback;
	const ext = extname(name);
	const stem = ext ? name.slice(0, -ext.length) : name;
	const safeStem = stem.slice(0, 120) || fallback;
	return `${safeStem}${ext.slice(0, 20)}`;
}

function safeSegment(input: string): string {
	return (
		input
			.trim()
			.replace(/[^\w.-]+/g, "_")
			.replace(/^[._]+|[._]+$/g, "")
			.slice(0, 80) || "unknown"
	);
}

function compact(input: Attachment): Attachment {
	const out: Attachment = { name: input.name, path: input.path };
	if (input.mimeType) out.mimeType = input.mimeType;
	if (input.size !== undefined) out.size = input.size;
	if (input.provider) out.provider = input.provider;
	if (input.id) out.id = input.id;
	if (input.sourceUrl) out.sourceUrl = input.sourceUrl;
	return out;
}

function compactResolved(input: ResolvedAttachment): ResolvedAttachment {
	const out: ResolvedAttachment = { path: input.path, name: input.name, size: input.size };
	if (input.mimeType) out.mimeType = input.mimeType;
	return out;
}

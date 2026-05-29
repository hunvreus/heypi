import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile, stat, writeFile } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { promisify } from "node:util";
import type { AttachmentConfig } from "../config.js";
import type { Logger } from "../core/log.js";
import type { ScopedKey } from "../core/scope.js";
import type { ReplyAttachment } from "../core/types.js";
import { hostMkdir, hostRealPath, hostWritePath, virtualPath } from "../runtime/path.js";
import type { Runtime } from "../runtime/types.js";

const runFile = promisify(execFile);

export type Attachment = {
	name: string;
	path: string;
	mimeType?: string;
	size?: number;
	provider?: string;
	id?: string;
	sourceUrl?: string;
	scope?: string;
};

type AttachmentSaveInput = {
	provider: string;
	id?: string;
	name: string;
	data: Uint8Array;
	mimeType?: string;
	sourceUrl?: string;
	messageId?: string;
	scope?: ScopedKey;
};

export interface AttachmentStore {
	maxBytes?: number;
	save(input: AttachmentSaveInput): Promise<Attachment>;
	resolve(input: ReplyAttachment, scope?: ScopedKey): Promise<ResolvedAttachment>;
}

export type ResolvedAttachment = {
	path: string;
	name: string;
	mimeType?: string;
	size: number;
};

export type ImageAttachment = {
	type: "image";
	data: string;
	mimeType: string;
};

export type AttachmentInput = {
	text: string;
	images: ImageAttachment[];
};

export type AttachmentProcessingConfig = {
	documents?: false | DocumentConverterConfig;
};

export type DocumentConverterConfig =
	| true
	| {
			command?: string;
			args?: string[];
			env?: Record<string, string>;
			timeoutMs?: number;
			maxBytes?: number;
			maxOutputBytes?: number;
			extensions?: string[];
			mimeTypes?: string[];
	  };

/** Creates a workspace-backed attachment store. Writes inbound files under a separate scoped attachment tree. */
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
			const root = attachmentRoot(input.scope);
			const relative = join(root, "incoming", provider, message, `${id}-${name}`);
			await hostMkdir(runtime.root, join(root, "incoming", provider, message));
			const full = await hostWritePath(runtime.root, relative);
			await writeFile(full, input.data);
			return compact({
				name,
				path: runtime.name === "just-bash" ? virtualPath(relative) : relative,
				mimeType: input.mimeType,
				size: input.data.byteLength,
				provider: input.provider,
				id: input.id,
				sourceUrl: input.sourceUrl,
				scope: input.scope?.path,
			});
		},
		async resolve(input, scope): Promise<ResolvedAttachment> {
			assertAttachmentScope(input, scope);
			const full = await hostRealPath(runtime.root, input.path);
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

function attachmentRoot(scope: ScopedKey | undefined): string {
	return scope ? join("attachments", "scopes", scope.path) : "";
}

function assertAttachmentScope(input: ReplyAttachment, scope: ScopedKey | undefined): void {
	if (!scope) return;
	if ("scope" in input && input.scope !== undefined && input.scope !== scope.path) {
		throw new Error("attachment scope mismatch");
	}
	const path = input.path.replace(/^\/+/, "");
	const allowed = [join("attachments", "scopes", scope.path), join("scopes", scope.path)];
	if (!allowed.some((prefix) => path === prefix || path.startsWith(`${prefix}/`))) {
		throw new Error("attachment scope mismatch");
	}
}

export async function responseBytes(response: Response, maxBytes?: number): Promise<Uint8Array> {
	const length = response.headers.get("content-length");
	if (maxBytes !== undefined && length && Number(length) > maxBytes) {
		throw new Error(`attachment exceeds limit: ${length} > ${maxBytes}`);
	}
	if (!response.body) {
		const data = new Uint8Array(await response.arrayBuffer());
		if (maxBytes !== undefined && data.byteLength > maxBytes) {
			throw new Error(`attachment exceeds limit: ${data.byteLength} > ${maxBytes}`);
		}
		return data;
	}
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		total += value.byteLength;
		if (maxBytes !== undefined && total > maxBytes) {
			await reader.cancel();
			throw new Error(`attachment exceeds limit: ${total} > ${maxBytes}`);
		}
		chunks.push(value);
	}
	const out = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		out.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return out;
}

export function attachmentPrompt(text: string, attachments?: Attachment[]): string {
	const body = text.trim();
	if (!attachments?.length) return body;
	const lines = attachments.map((file) => `- ${file.name}: ${file.path}${details(file)}`);
	return [body, "Attachments:", ...lines].filter(Boolean).join("\n");
}

/** Converts saved provider attachments into Pi-style prompt text and image inputs. */
export async function attachmentInput(
	runtime: Runtime,
	text: string,
	attachments?: Attachment[],
	config: AttachmentProcessingConfig = {},
	logger?: Logger,
): Promise<AttachmentInput> {
	if (!attachments?.length) return { text: text.trim(), images: [] };
	const images: ImageAttachment[] = [];
	const parts = [text.trim()].filter(Boolean);
	const refs: Attachment[] = [];
	for (const attachment of attachments) {
		const full = await hostRealPath(runtime.root, attachment.path);
		const mimeType = supportedImageMime(attachment);
		if (mimeType) {
			const data = await readFile(full);
			images.push({ type: "image", data: data.toString("base64"), mimeType });
			parts.push(`<file name="${attachment.path}"></file>`);
			continue;
		}
		if (textFile(attachment)) {
			try {
				const content = await readFile(full, "utf8");
				parts.push(`<file name="${attachment.path}">\n${content}\n</file>`);
				continue;
			} catch {
				refs.push(attachment);
				continue;
			}
		}
		const markdown = await convertDocument({ attachment, full, config: config.documents, logger });
		if (markdown !== undefined) {
			parts.push(`<file name="${attachment.path}">\n${markdown}\n</file>`);
			continue;
		}
		refs.push(attachment);
	}
	const prompt = refs.length ? attachmentPrompt(parts.join("\n"), refs) : parts.join("\n");
	return { text: prompt, images };
}

function details(file: Attachment): string {
	const values = [file.mimeType, file.size === undefined ? undefined : `${file.size} bytes`].filter(Boolean);
	return values.length ? ` (${values.join(", ")})` : "";
}

function supportedImageMime(file: Attachment): string | undefined {
	const mime = file.mimeType?.toLowerCase();
	if (mime && ["image/jpeg", "image/png", "image/gif", "image/webp"].includes(mime)) return mime;
	const ext = extname(file.name).toLowerCase();
	if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
	if (ext === ".png") return "image/png";
	if (ext === ".gif") return "image/gif";
	if (ext === ".webp") return "image/webp";
	return undefined;
}

function textFile(file: Attachment): boolean {
	const mime = file.mimeType?.toLowerCase();
	if (mime?.startsWith("text/")) return true;
	if (
		mime &&
		[
			"application/json",
			"application/xml",
			"application/x-yaml",
			"application/yaml",
			"application/javascript",
			"application/typescript",
			"application/x-sh",
		].includes(mime)
	) {
		return true;
	}
	return [
		".c",
		".conf",
		".cpp",
		".css",
		".csv",
		".go",
		".html",
		".java",
		".js",
		".json",
		".jsx",
		".log",
		".md",
		".py",
		".rs",
		".sh",
		".sql",
		".ts",
		".tsx",
		".txt",
		".xml",
		".yaml",
		".yml",
	].includes(extname(file.name).toLowerCase());
}

async function convertDocument(input: {
	attachment: Attachment;
	full: string;
	config?: false | DocumentConverterConfig;
	logger?: Logger;
}): Promise<string | undefined> {
	if (!input.config) return undefined;
	const config = input.config === true ? {} : input.config;
	if (!documentSupported(input.attachment, config)) return undefined;
	const size = input.attachment.size ?? (await stat(input.full).catch(() => undefined))?.size;
	if (config.maxBytes !== undefined && size !== undefined && size > config.maxBytes) {
		input.logger?.warn("attachment.document_too_large", {
			path: input.attachment.path,
			size,
			maxBytes: config.maxBytes,
		});
		return undefined;
	}
	const command = config.command ?? process.env.HEYPI_DOCUMENT_CONVERTER ?? "heypi-convert-document";
	try {
		const out = await runFile(command, [...(config.args ?? []), input.full], {
			timeout: config.timeoutMs ?? 15_000,
			maxBuffer: config.maxOutputBytes ?? 1_000_000,
			encoding: "utf8",
			env: config.env ?? { PATH: process.env.PATH ?? "" },
		});
		const text = out.stdout.trim();
		return text || undefined;
	} catch (error) {
		input.logger?.warn("attachment.document_failed", {
			path: input.attachment.path,
			error: error instanceof Error ? error.message : String(error),
		});
		return undefined;
	}
}

function documentSupported(file: Attachment, config: Exclude<DocumentConverterConfig, true>): boolean {
	const ext = extname(file.name).toLowerCase();
	const extensions = config.extensions ?? [".pdf", ".doc", ".docx", ".ppt", ".pptx", ".xls", ".xlsx", ".epub"];
	if (extensions.includes(ext)) return true;
	const mime = file.mimeType?.toLowerCase();
	return Boolean(mime && config.mimeTypes?.map((value) => value.toLowerCase()).includes(mime));
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
	if (input.scope) out.scope = input.scope;
	return out;
}

function compactResolved(input: ResolvedAttachment): ResolvedAttachment {
	const out: ResolvedAttachment = { path: input.path, name: input.name, size: input.size };
	if (input.mimeType) out.mimeType = input.mimeType;
	return out;
}

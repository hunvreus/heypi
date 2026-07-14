import { mkdir, writeFile } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import type { ChatAttachment } from "./types.js";

const MAX_ATTACHMENT_BYTES = 50 * 1024 * 1024;
const ATTACHMENT_DOWNLOAD_TIMEOUT_MS = 30_000;

function safeName(value: string): string {
	const cleaned = value.replaceAll(/[^a-zA-Z0-9_.-]/g, "_").replaceAll(/^_+|_+$/g, "");
	return cleaned && cleaned !== "." && cleaned !== ".." ? cleaned : "attachment";
}

function fallbackName(attachment: ChatAttachment, index: number): string {
	if (attachment.name) return safeName(basename(attachment.name));
	const ext = attachment.mime ? extensionForMime(attachment.mime) : "";
	return `attachment-${index + 1}${ext}`;
}

function extensionForMime(mime: string): string {
	if (mime === "image/jpeg") return ".jpg";
	if (mime === "image/png") return ".png";
	if (mime === "image/gif") return ".gif";
	if (mime === "image/webp") return ".webp";
	if (mime === "application/pdf") return ".pdf";
	if (mime.startsWith("text/")) return ".txt";
	return "";
}

function uniqueName(name: string, used: Set<string>): string {
	const safe = safeName(name);
	if (!used.has(safe)) {
		used.add(safe);
		return safe;
	}
	const ext = extname(safe);
	const base = ext ? safe.slice(0, -ext.length) : safe;
	for (let index = 2; ; index++) {
		const candidate = `${base}-${index}${ext}`;
		if (!used.has(candidate)) {
			used.add(candidate);
			return candidate;
		}
	}
}

async function fetchAttachment(
	url: string,
	headers?: HeadersInit,
	timeoutMs = ATTACHMENT_DOWNLOAD_TIMEOUT_MS,
): Promise<{ data: Buffer; mime?: string }> {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), timeoutMs);
	try {
		const response = await fetch(url, { headers, signal: controller.signal });
		if (!response.ok) throw new Error(`attachment download failed: ${response.status}`);
		const length = Number(response.headers.get("content-length"));
		if (Number.isFinite(length) && length > MAX_ATTACHMENT_BYTES) throw new Error("attachment is too large");
		const data = Buffer.from(await response.arrayBuffer());
		if (data.byteLength > MAX_ATTACHMENT_BYTES) throw new Error("attachment is too large");
		return { data, mime: response.headers.get("content-type") ?? undefined };
	} catch (error) {
		if (controller.signal.aborted) throw new Error("attachment download timed out");
		throw error;
	} finally {
		clearTimeout(timeout);
	}
}

export type MaterializeAttachmentOptions = {
	dir: string;
	displayDir?: string;
	headers?: HeadersInit;
	timeoutMs?: number;
	resolveUrl?(attachment: ChatAttachment): Promise<string | undefined> | string | undefined;
};

/**
 * Downloads remote adapter attachments into the runtime-visible workspace.
 *
 * Existing local/path attachments are preserved. Remote attachments that cannot
 * be resolved are left unchanged so adapters can still expose metadata.
 */
export async function materializeAttachments(
	attachments: ChatAttachment[] | undefined,
	options: MaterializeAttachmentOptions,
): Promise<ChatAttachment[] | undefined> {
	if (!attachments?.length) return attachments;
	await mkdir(options.dir, { recursive: true });
	const used = new Set<string>();
	return Promise.all(
		attachments.map(async (attachment, index) => {
			if (attachment.localPath || attachment.path) return attachment;
			const url = (await options.resolveUrl?.(attachment)) ?? attachment.url;
			if (!url) return attachment;
			const file = await fetchAttachment(url, options.headers, options.timeoutMs);
			const name = uniqueName(fallbackName(attachment, index), used);
			const localPath = join(options.dir, name);
			await writeFile(localPath, file.data, { mode: 0o600 });
			const displayDir = options.displayDir ?? "attachments";
			return {
				...attachment,
				name,
				path: `${displayDir}/${name}`,
				localPath,
				mime: attachment.mime ?? file.mime,
			};
		}),
	);
}

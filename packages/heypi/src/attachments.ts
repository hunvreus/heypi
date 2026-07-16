import { mkdir, rm, writeFile } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { retryAfter, retryConfig, retryDelay, retryWait } from "./retry.js";
import type { AttachmentPolicy, ChatAttachment } from "./types.js";

const MAX_ATTACHMENT_BYTES = 50 * 1024 * 1024;
const ATTACHMENT_DOWNLOAD_TIMEOUT_MS = 30_000;
const MAX_ATTACHMENT_REDIRECTS = 5;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

class AttachmentPolicyError extends Error {}

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
	maxBytes = MAX_ATTACHMENT_BYTES,
	retry: AttachmentPolicy["retry"] = undefined,
	hosts?: string[],
): Promise<{ data: Buffer; mime?: string }> {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), timeoutMs);
	try {
		const retries = retryConfig(retry);
		for (let attempt = 1; attempt <= retries.attempts; attempt++) {
			let response: Response;
			try {
				response = await fetchWithRedirectPolicy(url, headers, hosts, controller.signal);
			} catch (error) {
				if (error instanceof AttachmentPolicyError) throw error;
				if (controller.signal.aborted || attempt === retries.attempts) throw error;
				await retryWait(retryDelay(retries, attempt), controller.signal);
				continue;
			}
			if ((response.status === 429 || response.status >= 500) && attempt < retries.attempts) {
				await response.body?.cancel();
				await retryWait(
					retryDelay(retries, attempt, retryAfter(response.headers.get("retry-after"))),
					controller.signal,
				);
				continue;
			}
			if (!response.ok) {
				await response.body?.cancel();
				throw new Error(`attachment download failed: ${response.status}`);
			}
			const length = Number(response.headers.get("content-length"));
			if (Number.isFinite(length) && length > maxBytes) {
				await response.body?.cancel();
				throw new Error("attachment is too large");
			}
			if (!response.body) {
				return { data: Buffer.alloc(0), mime: response.headers.get("content-type") ?? undefined };
			}
			const reader = response.body.getReader();
			const chunks: Buffer[] = [];
			let bytes = 0;
			while (true) {
				const chunk = await reader.read();
				if (chunk.done) break;
				bytes += chunk.value.byteLength;
				if (bytes > maxBytes) {
					await reader.cancel();
					throw new Error("attachment is too large");
				}
				chunks.push(Buffer.from(chunk.value));
			}
			const data = Buffer.concat(chunks, bytes);
			return { data, mime: response.headers.get("content-type") ?? undefined };
		}
		throw new Error("attachment download failed");
	} catch (error) {
		if (controller.signal.aborted) throw new Error("attachment download timed out");
		throw error;
	} finally {
		clearTimeout(timeout);
	}
}

async function fetchWithRedirectPolicy(
	url: string,
	headers: HeadersInit | undefined,
	hosts: string[] | undefined,
	signal: AbortSignal,
): Promise<Response> {
	let current = new URL(url);
	let requestHeaders = new Headers(headers);
	for (let redirects = 0; ; redirects++) {
		assertAllowedUrl(current.toString(), hosts);
		const response = await fetch(current, { headers: requestHeaders, redirect: "manual", signal });
		if (!REDIRECT_STATUSES.has(response.status)) return response;
		const location = response.headers.get("location");
		if (!location) return response;
		await response.body?.cancel();
		if (redirects >= MAX_ATTACHMENT_REDIRECTS) throw new AttachmentPolicyError("attachment has too many redirects");
		const next = new URL(location, current);
		assertAllowedUrl(next.toString(), hosts);
		if (next.origin !== current.origin) {
			requestHeaders = new Headers(requestHeaders);
			requestHeaders.delete("authorization");
			requestHeaders.delete("cookie");
		}
		current = next;
	}
}

export type MaterializeAttachmentOptions = {
	dir: string;
	displayDir?: string;
	headers?: HeadersInit;
	timeoutMs?: number;
	maxBytes?: number;
	mimeTypes?: string[];
	hosts?: string[];
	retry?: AttachmentPolicy["retry"];
	resolveUrl?(attachment: ChatAttachment): Promise<string | undefined> | string | undefined;
};

function allowedHost(host: string, patterns: string[]): boolean {
	return patterns.some((pattern) => {
		const expected = pattern.toLowerCase();
		return expected.startsWith("*.")
			? host.endsWith(expected.slice(1)) && host !== expected.slice(2)
			: host === expected;
	});
}

function assertAllowedUrl(value: string, hosts: string[] | undefined): void {
	const url = new URL(value);
	if (url.protocol === "data:" && hosts === undefined) return;
	if (url.protocol !== "https:" && url.protocol !== "http:") {
		throw new AttachmentPolicyError(`attachment URL protocol is not allowed: ${url.protocol}`);
	}
	if (hosts && !allowedHost(url.hostname.toLowerCase(), hosts)) {
		throw new AttachmentPolicyError(`attachment host is not allowed: ${url.hostname}`);
	}
}

function normalizedMime(value: string | undefined): string | undefined {
	return value?.split(";", 1)[0]?.trim().toLowerCase() || undefined;
}

function mimeAllowed(value: string | undefined, patterns: string[] | undefined): boolean {
	if (!patterns) return true;
	if (!value) return false;
	return patterns.some((pattern) => {
		const expected = pattern.toLowerCase();
		return expected.endsWith("/*") ? value.startsWith(expected.slice(0, -1)) : value === expected;
	});
}

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
	const resolved = await Promise.all(
		attachments.map(async (attachment) => ({
			attachment,
			url:
				attachment.localPath || attachment.path
					? undefined
					: ((await options.resolveUrl?.(attachment)) ?? attachment.url),
		})),
	);
	const used = new Set<string>();
	const materialized: ChatAttachment[] = [];
	const created: string[] = [];
	try {
		for (const [index, { attachment, url }] of resolved.entries()) {
			if (!url) {
				materialized.push(attachment);
				continue;
			}
			const name = uniqueName(fallbackName(attachment, index), used);
			try {
				const declaredMime = normalizedMime(attachment.mime);
				if (declaredMime && !mimeAllowed(declaredMime, options.mimeTypes)) {
					throw new Error(`attachment MIME type is not allowed: ${declaredMime ?? "unknown"}`);
				}
				const file = await fetchAttachment(
					url,
					options.headers,
					options.timeoutMs,
					options.maxBytes,
					options.retry,
					options.hosts,
				);
				const responseMime = normalizedMime(file.mime);
				if (responseMime && !mimeAllowed(responseMime, options.mimeTypes)) {
					throw new Error(`attachment MIME type is not allowed: ${responseMime}`);
				}
				const mime = declaredMime ?? responseMime;
				if (!mimeAllowed(mime, options.mimeTypes)) {
					throw new Error(`attachment MIME type is not allowed: ${mime ?? "unknown"}`);
				}
				const localPath = join(options.dir, name);
				await writeFile(localPath, file.data, { mode: 0o600 });
				created.push(localPath);
				materialized.push({
					...attachment,
					name,
					path: `${options.displayDir ?? "attachments"}/${name}`,
					localPath,
					mime,
				});
			} catch (error) {
				throw new Error(
					`Failed to materialize attachment ${name}: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
		}
		return materialized;
	} catch (error) {
		await Promise.allSettled(created.map((path) => rm(path, { force: true })));
		throw error;
	}
}

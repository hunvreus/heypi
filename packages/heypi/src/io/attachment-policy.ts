import { message as errorMessage, type Logger } from "../core/log.js";
import type { ScopedKey } from "../core/scope.js";
import type { ReplyAttachment } from "../core/types.js";
import type { Attachment, AttachmentStore, ResolvedAttachment } from "./attachments.js";

export type ProviderAttachmentRef = {
	id?: string;
	name: string;
	mimeType?: string;
	size?: number;
	sourceUrl?: string;
};

export type AttachmentUploadStatus = "uploaded" | "failed" | "unknown";

export type AttachmentUploadSummary = {
	requested: number;
	resolved: number;
	status: AttachmentUploadStatus;
};

export function attachmentUploadSucceeded(input: AttachmentUploadSummary): boolean {
	return input.requested === 0 || (input.status === "uploaded" && input.resolved === input.requested);
}

export function attachmentUploadNoticeText(input: {
	upload: AttachmentUploadSummary;
	acceptedHint: string;
	unknownHint?: string;
}): string | undefined {
	if (!input.upload.requested || attachmentUploadSucceeded(input.upload)) return undefined;
	if (input.upload.status === "unknown" && input.unknownHint) return input.unknownHint;
	if (input.upload.resolved > 0) return input.acceptedHint;
	return "I created the file, but heypi could not resolve it for upload. Check server logs for the attachment path error.";
}

export function attachmentUploadText(names: string[]): string {
	const label = names.length === 1 ? names[0] : `${names.length} files`;
	return `Attached: ${label}`;
}

export async function saveInboundAttachments<T extends ProviderAttachmentRef>(input: {
	provider: string;
	kind: string;
	refs: T[] | undefined;
	store?: AttachmentStore;
	scope?: ScopedKey;
	messageId?: string;
	trace?: string;
	logItemField: string;
	logger: Logger;
	download(ref: T): Promise<Uint8Array>;
}): Promise<Attachment[] | undefined> {
	if (!input.store || !input.refs?.length) return undefined;
	const out: Attachment[] = [];
	for (const ref of input.refs) {
		if (input.store.maxBytes !== undefined && ref.size !== undefined && ref.size > input.store.maxBytes) {
			input.logger.warn(`${input.provider}.attachment_too_large`, {
				trace: input.trace,
				adapter: input.provider,
				kind: input.kind,
				[input.logItemField]: ref.id ?? ref.name,
				size: ref.size,
				maxBytes: input.store.maxBytes,
			});
			continue;
		}
		try {
			const data = await input.download(ref);
			out.push(
				await input.store.save({
					provider: input.provider,
					id: ref.id,
					name: ref.name,
					data,
					mimeType: ref.mimeType,
					sourceUrl: ref.sourceUrl,
					messageId: input.messageId,
					scope: input.scope,
				}),
			);
		} catch (error) {
			input.logger.warn(`${input.provider}.attachment_failed`, {
				trace: input.trace,
				adapter: input.provider,
				kind: input.kind,
				[input.logItemField]: ref.id ?? ref.name,
				error: errorMessage(error),
			});
		}
	}
	return out.length ? out : undefined;
}

export async function resolveOutboundAttachments(input: {
	provider: string;
	store?: AttachmentStore;
	attachments?: ReplyAttachment[];
	scope?: ScopedKey;
	logger: Logger;
	context: Record<string, unknown>;
}): Promise<ResolvedAttachment[]> {
	if (!input.attachments?.length) return [];
	if (!input.store) {
		input.logger.warn(`${input.provider}.attachments_missing_store`, input.context);
		return [];
	}
	const out: ResolvedAttachment[] = [];
	for (const attachment of input.attachments) {
		try {
			const file = await input.store.resolve(attachment, input.scope);
			if (input.store.maxBytes !== undefined && file.size > input.store.maxBytes) {
				input.logger.warn(`${input.provider}.attachment_upload_too_large`, {
					...input.context,
					path: attachment.path,
					size: file.size,
					maxBytes: input.store.maxBytes,
				});
				continue;
			}
			out.push(file);
		} catch (error) {
			input.logger.warn(`${input.provider}.attachment_resolve_failed`, {
				...input.context,
				path: attachment.path,
				error: errorMessage(error),
			});
		}
	}
	return out;
}

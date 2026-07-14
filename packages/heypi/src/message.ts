import type { ChatAttachment } from "./types.js";

export function chunkText(text: string, limit: number): string[] {
	if (text.length <= limit) return [text];
	const normalized = text.replace(/\r\n/g, "\n");
	const chunks: string[] = [];
	let current = "";

	function pushCurrent(): void {
		if (current.trim().length > 0) chunks.push(current);
		current = "";
	}

	function splitLongLine(line: string): string[] {
		const parts: string[] = [];
		let remaining = line;
		while (remaining.length > limit) {
			let splitAt = remaining.lastIndexOf(" ", limit);
			if (splitAt < Math.floor(limit * 0.6)) splitAt = limit;
			parts.push(remaining.slice(0, splitAt));
			remaining = remaining.slice(splitAt).trimStart();
		}
		if (remaining) parts.push(remaining);
		return parts;
	}

	for (const paragraph of normalized.split(/\n\n+/)) {
		if (!paragraph) continue;
		const parts = paragraph.length <= limit ? [paragraph] : paragraph.split("\n").flatMap(splitLongLine);
		for (const part of parts) {
			const candidate = current ? `${current}\n\n${part}` : part;
			if (candidate.length <= limit) current = candidate;
			else {
				pushCurrent();
				current = part;
			}
		}
	}
	pushCurrent();
	return chunks.length > 0 ? chunks : [normalized.slice(0, limit)];
}

export function splitLocalAttachments(attachments?: ChatAttachment[]): {
	local: ChatAttachment[];
	references: ChatAttachment[];
} {
	const local: ChatAttachment[] = [];
	const references: ChatAttachment[] = [];
	for (const attachment of attachments ?? []) {
		if (attachment.localPath) local.push(attachment);
		else references.push(attachment);
	}
	return { local, references };
}

function attachmentTarget(attachment: ChatAttachment): string | undefined {
	return attachment.url ?? attachment.path ?? attachment.id;
}

function attachmentLabel(attachment: ChatAttachment): string {
	return attachment.name ?? attachment.mime ?? "attachment";
}

export function formatOutgoingText(text: string, attachments?: ChatAttachment[]): string {
	const rows = (attachments ?? [])
		.map((attachment) => {
			const target = attachmentTarget(attachment);
			if (!target) return undefined;
			return `- ${attachmentLabel(attachment)}: ${target}`;
		})
		.filter((row): row is string => Boolean(row));
	if (rows.length === 0) return text;
	const body = text.trimEnd();
	const section = ["Attachments:", ...rows].join("\n");
	return body ? `${body}\n\n${section}` : section;
}

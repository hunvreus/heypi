import type { ChatAttachment } from "./types.js";

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

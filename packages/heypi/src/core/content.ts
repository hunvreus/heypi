/** Extracts text parts from Pi message content. Non-text content is intentionally ignored. */
export function textContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((part) => textPart(part))
		.filter(Boolean)
		.join("\n");
}

function textPart(part: unknown): string {
	if (!part || typeof part !== "object") return "";
	const input = part as { type?: unknown; text?: unknown };
	return input.type === "text" && typeof input.text === "string" ? input.text : "";
}

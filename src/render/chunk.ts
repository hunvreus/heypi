/** Splits provider-bound text into deterministic chunks no longer than `limit`. */
export function chunkText(text: string, limit: number): string[] {
	if (!Number.isInteger(limit) || limit < 1) throw new Error(`invalid chunk limit: ${limit}`);
	if (text.length === 0) return [];
	if (text.length <= limit) return [text];

	const normalized = text.replace(/\r\n/g, "\n");
	const chunks: string[] = [];
	let current = "";

	const pushCurrent = () => {
		if (current.length > 0) chunks.push(current);
		current = "";
	};

	for (const paragraph of normalized.split(/\n\n+/)) {
		if (!paragraph) continue;
		for (const part of splitBlock(paragraph, limit)) {
			const candidate = current.length === 0 ? part : `${current}\n\n${part}`;
			if (candidate.length <= limit) {
				current = candidate;
				continue;
			}
			pushCurrent();
			current = part;
		}
	}

	pushCurrent();
	return chunks.length > 0 ? chunks : [normalized.slice(0, limit)];
}

function splitBlock(block: string, limit: number): string[] {
	if (block.length <= limit) return [block];
	const chunks: string[] = [];
	let current = "";

	for (const line of block.split("\n")) {
		const candidate = current.length === 0 ? line : `${current}\n${line}`;
		if (candidate.length <= limit) {
			current = candidate;
			continue;
		}
		if (current.length > 0) {
			chunks.push(current);
			current = "";
		}
		if (line.length <= limit) {
			current = line;
			continue;
		}
		chunks.push(...splitLongLine(line, limit));
	}

	if (current.length > 0) chunks.push(current);
	return chunks;
}

function splitLongLine(line: string, limit: number): string[] {
	const chunks: string[] = [];
	let remaining = line;
	while (remaining.length > limit) {
		let splitAt = remaining.lastIndexOf(" ", limit);
		if (splitAt < Math.floor(limit * 0.6)) splitAt = limit;
		chunks.push(remaining.slice(0, splitAt));
		remaining = remaining.slice(splitAt).trimStart();
	}
	if (remaining.length > 0) chunks.push(remaining);
	return chunks;
}

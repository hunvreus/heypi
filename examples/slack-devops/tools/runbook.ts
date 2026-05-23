import { readFileSync, statSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { tool } from "@hunvreus/heypi";
import { Type } from "@sinclair/typebox";

type Hit = { file: string; line: number; text: string };

type RunbookToolOptions = {
	root: string;
};

export function createRunbookTools(options: RunbookToolOptions) {
	const root = resolve(options.root);
	return [
		tool<{ query: string; max_results?: number }>({
			name: "runbook_search",
			description: "Search bundled Markdown runbooks and return matching lines.",
			parameters: Type.Object({
				query: Type.String({ minLength: 2, description: "Search query." }),
				max_results: Type.Optional(Type.Integer({ minimum: 1, maximum: 20, default: 6 })),
			}),
			execute: async ({ query, max_results }) => {
				const maxResults = max_results ?? 6;
				try {
					const st = statSync(root);
					if (!st.isDirectory()) return "runbooks path exists but is not a directory";
				} catch {
					return "no runbooks directory found";
				}

				const files = await listMd(root);
				if (!files.length) return "no markdown runbooks found";

				const hits: Hit[] = [];
				for (const file of files) {
					hits.push(...findHits(file, query, maxResults));
					if (hits.length >= maxResults) break;
				}
				if (!hits.length) return `no matches for "${query}"`;

				return [
					`runbook matches for "${query}":`,
					...hits
						.slice(0, maxResults)
						.map((hit, index) => `${index + 1}. ${relative(root, hit.file)}:${hit.line} ${hit.text}`),
				].join("\n");
			},
		}),
	];
}

async function listMd(dir: string): Promise<string[]> {
	const out: string[] = [];
	const entries = await readdir(dir, { withFileTypes: true });
	for (const entry of entries) {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) {
			out.push(...(await listMd(path)));
			continue;
		}
		if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) out.push(path);
	}
	return out;
}

function findHits(file: string, query: string, limit: number): Hit[] {
	const text = readFileSync(file, "utf8");
	const lines = text.split(/\r?\n/);
	const q = query.toLowerCase();
	const hits: Hit[] = [];
	for (let i = 0; i < lines.length; i++) {
		if (!lines[i].toLowerCase().includes(q)) continue;
		hits.push({ file, line: i + 1, text: lines[i].trim() });
		if (hits.length >= limit) return hits;
	}
	return hits;
}

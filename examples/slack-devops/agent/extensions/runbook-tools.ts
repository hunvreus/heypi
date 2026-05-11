import { readFileSync, statSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";

type Hit = { file: string; line: number; text: string };
const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

async function listMd(dir: string): Promise<string[]> {
	const out: string[] = [];
	const entries = await readdir(dir, { withFileTypes: true });
	for (const entry of entries) {
		const p = join(dir, entry.name);
		if (entry.isDirectory()) {
			out.push(...(await listMd(p)));
			continue;
		}
		if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) {
			out.push(p);
		}
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

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "runbook_search",
		label: "Runbook Search",
		description: "Search markdown runbooks bundled with this agent and return matching lines.",
		parameters: Type.Object({
			query: Type.String({ minLength: 2, description: "search query" }),
			max_results: Type.Optional(Type.Integer({ minimum: 1, maximum: 20, default: 6 })),
		}),
		async execute(_toolCallId, params) {
			const input = params as { query: string; max_results?: number };
			const maxResults = input.max_results ?? 6;
			const base = join(ROOT, "runbooks");
			try {
				const st = statSync(base);
				if (!st.isDirectory()) {
					return {
						content: [{ type: "text", text: "runbooks path exists but is not a directory" }],
						details: undefined,
					};
				}
			} catch {
				return { content: [{ type: "text", text: "no runbooks directory found" }], details: undefined };
			}

			const files = await listMd(base);
			if (files.length === 0) {
				return { content: [{ type: "text", text: "no markdown runbooks found" }], details: undefined };
			}

			const hits: Hit[] = [];
			for (const file of files) {
				hits.push(...findHits(file, input.query, maxResults));
				if (hits.length >= maxResults) break;
			}

			if (hits.length === 0) {
				return {
					content: [{ type: "text", text: `no matches for "${input.query}"` }],
					details: { query: input.query, total_files: files.length, matches: 0 },
				};
			}

			const body = [
				`runbook matches for "${input.query}":`,
				...hits.slice(0, maxResults).map((h, i) => `${i + 1}. ${h.file}:${h.line} ${h.text}`),
			].join("\n");
			return {
				content: [{ type: "text", text: body }],
				details: { query: input.query, total_files: files.length, matches: hits.length },
			};
		},
	});
}

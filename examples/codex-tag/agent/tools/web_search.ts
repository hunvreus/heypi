import { defineTool, type ExtensionAPI, Type } from "@hunvreus/heypi/authoring";

type SearchResult = {
	title: string;
	url: string;
	snippet?: string;
};

const MAX_RESULTS = 10;

const webSearchTool = defineTool({
	name: "web_search",
	label: "Web search",
	description: "Search the public web and return compact results with titles, URLs, and snippets.",
	parameters: Type.Object({
		query: Type.String({ minLength: 1, description: "Search query." }),
		maxResults: Type.Optional(
			Type.Number({ minimum: 1, maximum: MAX_RESULTS, description: "Maximum results to return." }),
		),
	}),
	async execute(_toolCallId, { query, maxResults }, signal) {
		const limit = Math.max(1, Math.min(MAX_RESULTS, Number(maxResults ?? 5)));
		const results = process.env.TAVILY_API_KEY
			? await tavilySearch(query, limit, signal)
			: await duckDuckGoSearch(query, limit, signal);
		const text = results.length
			? results
					.map((result, index) =>
						[
							`${index + 1}. ${result.title}`,
							`   URL: ${result.url}`,
							result.snippet ? `   Snippet: ${compact(result.snippet, 300)}` : undefined,
						]
							.filter(Boolean)
							.join("\n"),
					)
					.join("\n")
			: `No search results for: ${query}`;
		return { content: [{ type: "text", text }], details: { count: results.length } };
	},
});

export default function register(pi: ExtensionAPI) {
	pi.registerTool(webSearchTool);
}

async function tavilySearch(query: string, maxResults: number, signal?: AbortSignal): Promise<SearchResult[]> {
	const response = await fetch("https://api.tavily.com/search", {
		method: "POST",
		headers: {
			"content-type": "application/json",
			authorization: `Bearer ${process.env.TAVILY_API_KEY}`,
		},
		body: JSON.stringify({
			query,
			max_results: maxResults,
			search_depth: "basic",
			include_answer: false,
			include_raw_content: false,
		}),
		signal,
	});
	if (!response.ok) throw new Error(`Tavily search failed: ${response.status} ${await response.text()}`);
	const data = (await response.json()) as {
		results?: Array<{ title?: string; url?: string; content?: string }>;
	};
	return (data.results ?? [])
		.filter((item): item is { title?: string; url: string; content?: string } => typeof item.url === "string")
		.slice(0, maxResults)
		.map((item) => ({
			title: item.title?.trim() || item.url,
			url: item.url,
			snippet: item.content?.trim(),
		}));
}

async function duckDuckGoSearch(query: string, maxResults: number, signal?: AbortSignal): Promise<SearchResult[]> {
	const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
	const response = await fetch(url, {
		headers: { "user-agent": "Mozilla/5.0 heypi-codex-tag" },
		signal,
	});
	if (!response.ok) throw new Error(`DuckDuckGo search failed: ${response.status}`);
	const html = await response.text();
	const results: SearchResult[] = [];
	const itemPattern =
		/<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
	for (const match of html.matchAll(itemPattern)) {
		if (results.length >= maxResults) break;
		const url = decodeDuckDuckGoUrl(decodeHtml(stripTags(match[1] ?? "")));
		if (!url) continue;
		results.push({
			title: compact(decodeHtml(stripTags(match[2] ?? "")), 160),
			url,
			snippet: compact(decodeHtml(stripTags(match[3] ?? "")), 300),
		});
	}
	return results;
}

function decodeDuckDuckGoUrl(value: string): string {
	try {
		const parsed = new URL(value, "https://duckduckgo.com");
		const target = parsed.searchParams.get("uddg");
		return target ? decodeURIComponent(target) : parsed.href;
	} catch {
		return "";
	}
}

function stripTags(value: string): string {
	return value.replace(/<[^>]*>/g, " ");
}

function decodeHtml(value: string): string {
	return value
		.replace(/&amp;/g, "&")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'")
		.replace(/\s+/g, " ")
		.trim();
}

function compact(value: string, max: number): string {
	const normalized = value.replace(/\s+/g, " ").trim();
	if (normalized.length <= max) return normalized;
	return `${normalized.slice(0, max - 1)}...`;
}

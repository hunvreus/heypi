import { defineTool, type ExtensionAPI, Type } from "@hunvreus/heypi/authoring";
import { assertPublicUrl } from "../lib/public-url.js";

const MAX_CHARS = 12_000;
const MAX_BODY_BYTES = 1_000_000;
const FETCH_TIMEOUT_MS = 20_000;
const MAX_REDIRECTS = 5;

const fetchPageTool = defineTool({
	name: "fetch_page",
	label: "Fetch page",
	description: "Fetch a public web page and return cleaned readable text with basic metadata.",
	parameters: Type.Object({
		url: Type.String({ minLength: 1, description: "Public http or https URL to fetch." }),
		maxChars: Type.Optional(
			Type.Number({ minimum: 500, maximum: MAX_CHARS, description: "Maximum cleaned text characters." }),
		),
	}),
	async execute(_toolCallId, { url, maxChars }, signal) {
		const response = await fetchPublic(url, signal);
		if (!response.ok) throw new Error(`Fetch failed: ${response.status} ${response.statusText}`);
		const contentType = response.headers.get("content-type") ?? "";
		const raw = await readLimited(response, MAX_BODY_BYTES);
		const body = contentType.includes("html") ? htmlToText(raw) : raw;
		const limit = Math.max(500, Math.min(MAX_CHARS, Number(maxChars ?? 6000)));
		const title = contentType.includes("html") ? extractTitle(raw) : "";
		const description = contentType.includes("html") ? extractDescription(raw) : "";
		const text = [
			`URL: ${response.url}`,
			title ? `Title: ${title}` : undefined,
			description ? `Description: ${description}` : undefined,
			"",
			clip(body, limit),
		]
			.filter((line): line is string => typeof line === "string")
			.join("\n");
		return { content: [{ type: "text", text }], details: { url: response.url, contentType } };
	},
});

export default function register(pi: ExtensionAPI) {
	pi.registerTool(fetchPageTool);
}

async function fetchPublic(input: string, signal?: AbortSignal): Promise<Response> {
	let target = await assertPublicUrl(input);
	for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects++) {
		await assertPublicUrl(target);
		const response = await fetch(target, {
			headers: {
				accept: "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5",
				"user-agent": "Mozilla/5.0 heypi-codex-tag",
			},
			redirect: "manual",
			signal: timeoutSignal(signal),
		});
		if (!redirectStatus(response.status)) return response;
		const location = response.headers.get("location");
		if (!location) throw new Error(`Redirect failed: ${response.status} without location`);
		target = new URL(location, response.url || target).href;
	}
	throw new Error(`Too many redirects; stopped after ${MAX_REDIRECTS}`);
}

function redirectStatus(status: number): boolean {
	return status >= 300 && status < 400;
}

function timeoutSignal(signal?: AbortSignal): AbortSignal {
	const timeout = AbortSignal.timeout(FETCH_TIMEOUT_MS);
	return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

async function readLimited(response: Response, maxBytes: number): Promise<string> {
	const reader = response.body?.getReader();
	if (!reader) return "";
	const chunks: Uint8Array[] = [];
	let total = 0;
	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		if (!value) continue;
		total += value.byteLength;
		if (total > maxBytes) throw new Error(`Response body exceeded ${maxBytes} bytes`);
		chunks.push(value);
	}
	const out = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		out.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return new TextDecoder().decode(out);
}

function extractTitle(html: string): string {
	const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
	return match ? compact(decodeHtml(match[1] ?? ""), 180) : "";
}

function extractDescription(html: string): string {
	const match = html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["'][^>]*>/i);
	return match ? compact(decodeHtml(match[1] ?? ""), 300) : "";
}

function htmlToText(html: string): string {
	return decodeHtml(
		html
			.replace(/<script[\s\S]*?<\/script>/gi, " ")
			.replace(/<style[\s\S]*?<\/style>/gi, " ")
			.replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
			.replace(/<(br|p|div|section|article|header|footer|li|h[1-6])\b[^>]*>/gi, "\n")
			.replace(/<[^>]*>/g, " "),
	);
}

function decodeHtml(value: string): string {
	return value
		.replace(/&nbsp;/g, " ")
		.replace(/&amp;/g, "&")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'")
		.replace(/\r/g, "")
		.replace(/[ \t]+\n/g, "\n")
		.replace(/\n{3,}/g, "\n\n")
		.replace(/[ \t]{2,}/g, " ")
		.trim();
}

function compact(value: string, max: number): string {
	const normalized = value.replace(/\s+/g, " ").trim();
	if (normalized.length <= max) return normalized;
	return `${normalized.slice(0, max - 1)}...`;
}

function clip(value: string, max: number): string {
	if (value.length <= max) return value;
	return `${value.slice(0, max)}\n\n[${value.length - max} chars omitted]`;
}

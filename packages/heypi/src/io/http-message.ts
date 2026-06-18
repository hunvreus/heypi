import type { IncomingMessage, ServerResponse } from "node:http";
import type { Outbound, StatusResult } from "./handler.js";

export class HttpMessageError extends Error {
	constructor(
		readonly status: number,
		message: string,
	) {
		super(message);
	}
}

export function runningResponse(threadId: string, runId: string): Record<string, unknown> {
	return { ok: true, threadId, runId, status: "running" };
}

export function outboundResponse(
	threadId: string,
	runId: string,
	result: Outbound | undefined,
): Record<string, unknown> {
	return {
		ok: true,
		threadId,
		runId,
		status: result?.approval ? "pending_approval" : "done",
		text: result?.text,
		private: result?.private,
		silent: result?.silent,
		approval: result?.approval,
		attachments: result?.attachments,
	};
}

export function statusResponse(input: StatusResult): Record<string, unknown> {
	return input;
}

export async function readJsonBody<T>(req: IncomingMessage, maxBytes: number): Promise<T> {
	const chunks: Buffer[] = [];
	let total = 0;
	for await (const chunk of req) {
		const next = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
		total += next.byteLength;
		if (total > maxBytes) throw new HttpMessageError(413, "body too large");
		chunks.push(next);
	}
	if (!chunks.length) return {} as T;
	let parsed: unknown;
	try {
		parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
	} catch {
		throw new HttpMessageError(400, "invalid json body");
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new HttpMessageError(400, "body must be an object");
	}
	return parsed as T;
}

export function normalizeMessagePath(path: string): string {
	const value = `/${path.trim().replace(/^\/+|\/+$/g, "")}`;
	return value === "/" ? "" : value;
}

export function escapeRe(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function wait(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

export function json(res: ServerResponse, status: number, body: Record<string, unknown>): void {
	res.writeHead(status, { "content-type": "application/json" });
	res.end(JSON.stringify(body));
}

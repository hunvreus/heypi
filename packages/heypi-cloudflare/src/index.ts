import { ThreadAgent } from "./thread-agent.js";

export { ThreadAgent };

export type Env = {
	THREAD_AGENT: DurableObjectNamespace<ThreadAgent>;
};

type TurnRequest = { threadKey?: string; sessionId?: string; text?: string };

/**
 * Edge ingress. Stateless and request-scoped: it validates the request and routes it to the
 * Durable Object that owns the thread (one DO per threadKey). Provider signature verification
 * and the Slack/Telegram/webhook adapters layer on top of this in a later phase.
 */
export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const url = new URL(request.url);
		if (request.method !== "POST" || url.pathname !== "/turn") {
			return new Response("not found", { status: 404 });
		}

		let body: TurnRequest;
		try {
			body = (await request.json()) as TurnRequest;
		} catch {
			return new Response("invalid json", { status: 400 });
		}
		if (!body.threadKey || !body.sessionId || typeof body.text !== "string") {
			return new Response("threadKey, sessionId and text are required", { status: 400 });
		}

		// idFromName(threadKey) maps each thread to a single stable Durable Object.
		const stub = env.THREAD_AGENT.get(env.THREAD_AGENT.idFromName(body.threadKey));
		const result = await stub.turn({ sessionId: body.sessionId, text: body.text });
		return Response.json(result);
	},
} satisfies ExportedHandler<Env>;

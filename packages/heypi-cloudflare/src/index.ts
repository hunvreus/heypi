import { parseTelegramUpdate, sendTelegramMessage } from "./telegram.js";
import { ThreadAgent } from "./thread-agent.js";

export { ThreadAgent };

export type Env = {
	THREAD_AGENT: DurableObjectNamespace<ThreadAgent>;
	/** Base URL of the Pi runner service; forwarded to the DO so real agent turns run there. */
	RUNNER_URL?: string;
	/** Telegram bot token, used to send replies. Required for the /telegram webhook. */
	TELEGRAM_BOT_TOKEN?: string;
	/** Optional shared secret; if set, /telegram requires Telegram's matching secret-token header. */
	TELEGRAM_WEBHOOK_SECRET?: string;
};

type TurnRequest = { threadKey?: string; sessionId?: string; text?: string };

/** Runs one turn for a thread through its Durable Object. */
function runTurn(env: Env, threadKey: string, text: string): Promise<{ reply: string }> {
	const stub = env.THREAD_AGENT.get(env.THREAD_AGENT.idFromName(threadKey));
	return stub.turn({ sessionId: threadKey, text });
}

/**
 * Edge ingress. Stateless and request-scoped. Routes to the Durable Object that owns a thread
 * (one DO per threadKey). Telegram delivers over HTTP webhooks, so its adapter lives entirely here
 * with no bridge; /turn is a raw test endpoint.
 */
export default {
	async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		const url = new URL(request.url);

		// Telegram webhook: ack immediately, run the turn and reply in the background.
		if (request.method === "POST" && url.pathname === "/telegram") {
			if (
				env.TELEGRAM_WEBHOOK_SECRET &&
				request.headers.get("x-telegram-bot-api-secret-token") !== env.TELEGRAM_WEBHOOK_SECRET
			) {
				return new Response("forbidden", { status: 403 });
			}
			let update: unknown;
			try {
				update = await request.json();
			} catch {
				return new Response("invalid json", { status: 400 });
			}
			const message = parseTelegramUpdate(update);
			if (message && env.TELEGRAM_BOT_TOKEN) {
				const token = env.TELEGRAM_BOT_TOKEN;
				const threadKey = `telegram:${message.chatId}`;
				ctx.waitUntil(
					runTurn(env, threadKey, message.text).then(({ reply }) =>
						sendTelegramMessage(token, message.chatId, reply),
					),
				);
			}
			return new Response("ok");
		}

		// Raw test endpoint.
		if (request.method === "POST" && url.pathname === "/turn") {
			let body: TurnRequest;
			try {
				body = (await request.json()) as TurnRequest;
			} catch {
				return new Response("invalid json", { status: 400 });
			}
			if (!body.threadKey || !body.sessionId || typeof body.text !== "string") {
				return new Response("threadKey, sessionId and text are required", { status: 400 });
			}
			const result = await env.THREAD_AGENT.get(env.THREAD_AGENT.idFromName(body.threadKey)).turn({
				sessionId: body.sessionId,
				text: body.text,
			});
			return Response.json(result);
		}

		return new Response("not found", { status: 404 });
	},
} satisfies ExportedHandler<Env>;

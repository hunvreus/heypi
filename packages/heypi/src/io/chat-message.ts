import { message as errorMessage, type Logger } from "../core/log.js";
import type { ScopedKey } from "../core/scope.js";
import type { Attachment } from "./attachments.js";
import type { Handler, Inbound, Outbound } from "./handler.js";
import type { LogFields } from "./log-context.js";
import { dispatchPlacement } from "./output-placement.js";
import type { ReplyStream } from "./reply-stream.js";

type Progress = {
	notify?(text: string): Promise<void> | void;
	stop(): Promise<void> | void;
};

type PlacementHandlers = {
	fresh(out: Outbound): Promise<void>;
	streamed(out: Outbound): Promise<void>;
	progress(out: Outbound): Promise<void>;
};

export type ChatMessageRun = {
	logger: Pick<Logger, "error">;
	context(extra?: LogFields): LogFields;
	handler: Handler;
	stream?: ReplyStream;
	progress?: Progress;
	loadAttachments?: (scope: ScopedKey | undefined) => Promise<Attachment[] | undefined>;
	inbound(): Inbound;
	sendPrivate?: (out: Outbound) => Promise<void>;
	placement: PlacementHandlers;
	sendError(error: unknown): Promise<void>;
	afterSend?: (out: Outbound, visibility: "private" | "public") => Promise<void>;
};

/** Runs a normalized chat message through the shared handler and platform-provided send callbacks. */
export async function runChatMessage(input: ChatMessageRun): Promise<void> {
	try {
		const inbound = input.inbound();
		const scope = input.handler.attachmentScope?.(inbound);
		const attachments = await input.loadAttachments?.(scope);
		const runtimeProgress = input.progress?.notify
			? { update: (text: string) => input.progress?.notify?.(text) }
			: undefined;
		const out = await input.handler({ ...inbound, attachments, stream: input.stream, runtimeProgress });
		if (!out) return;
		if (out.private && input.sendPrivate) {
			await input.stream?.clear?.();
			await input.sendPrivate(out);
			await afterSend(input, out, "private");
			return;
		}
		if (out.private) await input.stream?.clear?.();
		await dispatchPlacement(out, input.stream, {
			fresh: async () => {
				await input.progress?.stop();
				await input.stream?.clear?.();
				await input.placement.fresh(out);
			},
			streamed: async () => {
				await input.progress?.stop();
				await input.placement.streamed(out);
			},
			progress: async () => {
				await input.placement.progress(out);
			},
		});
		await afterSend(input, out, "public");
	} catch (error) {
		input.logger.error("adapter.error", input.context({ error: errorMessage(error) }));
		await input.sendError(error);
	} finally {
		await input.progress?.stop();
	}
}

async function afterSend(input: ChatMessageRun, out: Outbound, visibility: "private" | "public"): Promise<void> {
	try {
		await input.afterSend?.(out, visibility);
	} catch (error) {
		input.logger.error("adapter.after_send_failed", input.context({ error: errorMessage(error) }));
	}
}

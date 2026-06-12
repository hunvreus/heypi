import type { Logger } from "../core/log.js";
import { logError, message } from "../core/log.js";
import type { ScopedKey } from "../core/scope.js";
import type { Secrets } from "../core/secrets.js";
import type { Runtime } from "../runtime/types.js";
import type { Thread } from "../store/types.js";
import type { Outbound } from "./handler.js";

export async function completeSecretReply(input: {
	rawText: string;
	secrets?: Secrets;
	runtime?: (scope?: string) => Runtime;
	scope: ScopedKey;
	trace: string;
	agent: string;
	provider: string;
	channel: string;
	thread: Thread;
	actor: string;
	log: Logger;
}): Promise<Outbound> {
	try {
		if (!input.secrets) return expired();
		const completed = input.secrets.complete(input.rawText, input.scope, input.actor);
		if (!completed) return expired();
		const runtime = input.runtime?.(input.scope.path);
		const paths = await input.secrets.save(completed, runtime);
		input.log.info("secret.saved", {
			trace: input.trace,
			agent: input.agent,
			provider: input.provider,
			channel: input.channel,
			thread: input.thread.id,
			actor: input.actor,
			fields: completed.files.map((file) => file.name).join(","),
		});
		return { text: `Secret saved: ${paths.join(", ")}`, private: true };
	} catch (error) {
		logError(input.log, "handler", {
			trace: input.trace,
			agent: input.agent,
			provider: input.provider,
			channel: input.channel,
			thread: input.thread.id,
			actor: input.actor,
			error: message(error),
		});
		return { text: "Secret could not be saved. Request a fresh secret link and try again.", private: true };
	}
}

function expired(): Outbound {
	return { text: "Secret request expired, invalid, or for another scope.", private: true };
}

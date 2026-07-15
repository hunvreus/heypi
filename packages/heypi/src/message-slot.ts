import type { Adapter, SendMessage, SentMessage } from "./types.js";

export type MessageSlot = {
	replace(text: string): Promise<void>;
};

export type MessageSlotOptions = {
	adapter: Adapter;
	target: Pick<SendMessage, "conversation" | "thread" | "replyTo">;
	onSent?(message: SentMessage | undefined): Promise<void>;
};

/** Maintain one editable adapter message. No-ops when message updates are unsupported. */
export function createMessageSlot(options: MessageSlotOptions): MessageSlot {
	const { adapter, target } = options;
	let messageId: string | undefined;
	let disabled = false;
	let text: string | undefined;
	let pending = Promise.resolve();

	function editable(): boolean {
		return Boolean(adapter.update) && !disabled;
	}

	function enqueue(operation: () => Promise<void>): Promise<void> {
		pending = pending.then(operation, operation).then(
			() => undefined,
			() => undefined,
		);
		return pending;
	}

	return {
		replace(nextText) {
			if (!editable() || nextText === text) return pending;
			text = nextText;
			return enqueue(async () => {
				if (!editable()) return;
				if (!messageId) {
					const sent = await adapter.send({ ...target, text: nextText });
					messageId = sent?.id;
					disabled = !messageId;
					await options.onSent?.(sent);
					return;
				}
				await adapter.update?.({ ...target, id: messageId, text: nextText });
			});
		},
	};
}

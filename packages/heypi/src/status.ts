import type { Adapter, ChatMessage } from "./types.js";

export type StatusSlot = {
	replace(text: string): void;
	clear(): Promise<void>;
	wait(): Promise<void>;
};

export type StatusSlotOptions = {
	adapter: Adapter;
	message: ChatMessage;
	thread?: string;
};

export function createStatusSlot(options: StatusSlotOptions): StatusSlot {
	const { adapter, message, thread } = options;
	let messageId: string | undefined;
	let uneditable = false;
	let text: string | undefined;
	const tasks: Promise<void>[] = [];

	function canEdit(): boolean {
		return adapter.progress !== false && Boolean(adapter.update) && !uneditable;
	}

	function enqueue(nextText: string): void {
		if (!canEdit() || nextText === text) return;
		text = nextText;
		const previous = tasks.at(-1) ?? Promise.resolve();
		const task = previous
			.then(async () => {
				if (!canEdit()) return;
				if (!messageId) {
					const sent = await adapter.send({
						conversation: message.conversation,
						thread,
						text: nextText,
					});
					messageId = sent?.id;
					uneditable = !sent?.id;
					return;
				}
				await adapter.update?.({
					conversation: message.conversation,
					thread,
					id: messageId,
					text: nextText,
				});
			})
			.then(
				() => undefined,
				() => undefined,
			);
		tasks.push(task);
	}

	async function clear(): Promise<void> {
		await Promise.allSettled(tasks);
		if (!messageId) return;
		try {
			await adapter.remove?.({ conversation: message.conversation, thread, id: messageId });
		} catch {}
		messageId = undefined;
		text = undefined;
	}

	return {
		replace(nextText) {
			enqueue(nextText);
		},
		clear,
		async wait() {
			await Promise.allSettled(tasks);
		},
	};
}

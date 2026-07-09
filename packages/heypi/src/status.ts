import type { Adapter, ChatMessage } from "./types.js";

export type StatusSlot = {
	replace(text: string): void;
	setTodo(text: string): void;
	clearTodo(): void;
	final(text: string): Promise<boolean>;
	error(text: string): Promise<boolean>;
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
	let todoActive = false;
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

	async function replace(nextText: string): Promise<boolean> {
		await Promise.allSettled(tasks);
		if (!messageId || !adapter.update) return false;
		try {
			await adapter.update({
				conversation: message.conversation,
				thread,
				id: messageId,
				text: nextText,
			});
			text = nextText;
			return true;
		} catch {
			return false;
		}
	}

	return {
		replace(nextText) {
			if (todoActive) return;
			enqueue(nextText);
		},
		setTodo(nextText) {
			todoActive = true;
			enqueue(nextText);
		},
		clearTodo() {
			todoActive = false;
		},
		async final(finalText) {
			if (todoActive) {
				await Promise.allSettled(tasks);
				return false;
			}
			return replace(finalText);
		},
		async error(errorText) {
			if (todoActive) {
				await Promise.allSettled(tasks);
				return false;
			}
			return replace(errorText);
		},
		async wait() {
			await Promise.allSettled(tasks);
		},
	};
}

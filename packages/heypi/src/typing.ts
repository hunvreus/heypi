import {
	type AdapterEvent,
	type AdapterEventHandler,
	type AdapterEvents,
	type AdapterEventType,
	busyEvents,
} from "./events.js";
import type { ChatMessage } from "./types.js";

export type TypingControls = {
	start(message: ChatMessage): void;
	stop(message: ChatMessage): void;
	stopAll(): void;
};

function key(message: ChatMessage): string {
	return `${message.conversation}:${message.thread ?? ""}`;
}

export function createTypingControls(
	interval: number,
	send: (message: ChatMessage) => Promise<void>,
	onError: (error: unknown) => void = () => undefined,
): TypingControls {
	const timers = new Map<string, ReturnType<typeof setInterval>>();
	const trigger = (message: ChatMessage) => void send(message).catch(onError);
	return {
		start(message) {
			const id = key(message);
			if (timers.has(id)) return;
			trigger(message);
			timers.set(
				id,
				setInterval(() => trigger(message), interval),
			);
		},
		stop(message) {
			const id = key(message);
			const timer = timers.get(id);
			if (!timer) return;
			clearInterval(timer);
			timers.delete(id);
		},
		stopAll() {
			for (const timer of timers.values()) clearInterval(timer);
			timers.clear();
		},
	};
}

/** Merge native typing lifecycle behavior with adapter event overrides. */
export function typingEvents(
	enabled: boolean | undefined,
	events: AdapterEvents | undefined,
	typing: TypingControls,
): AdapterEvents {
	if (enabled === false) return { ...busyEvents(), ...(events ?? {}) };

	function wrap<T extends AdapterEventType>(
		type: T,
		native: AdapterEventHandler<Extract<AdapterEvent, { type: T }>>,
	): AdapterEventHandler<Extract<AdapterEvent, { type: T }>> | false {
		const user = events?.[type] as AdapterEventHandler<Extract<AdapterEvent, { type: T }>> | false | undefined;
		if (user === false) return false;
		return async (event, context) => {
			await native(event, context);
			await user?.(event, context);
		};
	}

	return {
		...busyEvents(),
		...events,
		message_accepted: wrap("message_accepted", (_event, context) => typing.start(context.message)),
		turn_started: wrap("turn_started", (_event, context) => typing.start(context.message)),
		message_completed: wrap("message_completed", (_event, context) => typing.stop(context.message)),
		message_failed: wrap("message_failed", (_event, context) => typing.stop(context.message)),
		turn_failed: wrap("turn_failed", (_event, context) => typing.stop(context.message)),
		turn_canceled: wrap("turn_canceled", (_event, context) => typing.stop(context.message)),
	};
}

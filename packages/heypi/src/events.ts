import type { StatusSlot } from "./status.js";
import type { ChatMessage, SendMessage } from "./types.js";

export type ChatJobState = "queued" | "running" | "completed" | "failed" | "canceled";

export type ChatJob = {
	id: string;
	state: ChatJobState;
	conversation: string;
	thread?: string;
	adapter: string;
	adapterId: string;
	actor: { id: string; name?: string };
	startedAt?: string;
};

export type AdapterEventContext = {
	message: ChatMessage;
	job?: ChatJob;
	status?: StatusSlot;
	todo?: StatusSlot;
	send(message: SendMessage): Promise<{ id?: string } | undefined>;
	react?(emoji: string): Promise<void>;
};

export type AdapterEvent =
	| { type: "message.accepted"; origin: "heypi"; message: ChatMessage }
	| { type: "message.queued"; origin: "heypi"; message: ChatMessage }
	| { type: "message.steered"; origin: "heypi"; message: ChatMessage }
	| { type: "message.rejected"; origin: "heypi"; message: ChatMessage }
	| { type: "turn.started"; origin: "pi"; job: ChatJob }
	| { type: "tool.started"; origin: "pi"; job: ChatJob; tool: string }
	| { type: "todo.changed"; origin: "heypi"; job: ChatJob; text: string }
	| { type: "message.completed"; origin: "pi"; job: ChatJob; text: string }
	| { type: "turn.canceled"; origin: "heypi"; job: ChatJob; reason: string }
	| { type: "turn.failed"; origin: "heypi" | "pi"; job: ChatJob; error: string };

export type AdapterEventType = AdapterEvent["type"];

export type AdapterEventHandler<E extends AdapterEvent = AdapterEvent> = (
	event: E,
	context: AdapterEventContext,
) => Promise<void> | void;

export type AdapterEvents = {
	[K in AdapterEventType]?: AdapterEventHandler<Extract<AdapterEvent, { type: K }>> | false;
};

export function busyEvents(): AdapterEvents {
	return {
		"message.queued": async (_event, context) => {
			await context.send({
				conversation: context.message.conversation,
				thread: context.message.thread,
				text: "Queued. I’ll start it when the current task finishes.",
			});
		},
		"message.steered": async (_event, context) => {
			await context.send({
				conversation: context.message.conversation,
				thread: context.message.thread,
				text: "Updated the active task.",
			});
		},
		"message.rejected": async (_event, context) => {
			await context.send({
				conversation: context.message.conversation,
				thread: context.message.thread,
				text: "I’m already working on another request in this conversation.",
			});
		},
	};
}

export function statusEvents(): AdapterEvents {
	return {
		...busyEvents(),
		"message.accepted": (_event, context) => {
			context.status?.replace("Thinking...");
		},
		"turn.started": (_event, context) => {
			context.status?.replace("Thinking...");
		},
		"tool.started": (_event, context) => {
			context.status?.replace("Working...");
		},
		"todo.changed": (event, context) => {
			context.todo?.replace(event.text);
		},
	};
}

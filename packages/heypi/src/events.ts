import type { StatusSlot } from "./status.js";
import type { ChatMessage, SendMessage } from "./types.js";

export type ChatJobState = "queued" | "running" | "completed" | "failed" | "canceled";

export type ChatJob = {
	id: string;
	state: ChatJobState;
	conversation: string;
	thread?: string;
	adapter: string;
	account: string;
	actor: { id: string; name?: string };
	startedAt?: string;
};

export type AdapterEventContext = {
	message: ChatMessage;
	job?: ChatJob;
	status?: StatusSlot;
	send(message: SendMessage): Promise<{ id?: string } | undefined>;
};

export type AdapterEvent =
	| { type: "message.accepted"; origin: "heypi"; message: ChatMessage }
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

export function statusEvents(): Required<Pick<AdapterEvents, "turn.started" | "tool.started" | "todo.changed">> {
	return {
		"turn.started": (_event, context) => {
			context.status?.replace("Thinking...");
		},
		"tool.started": (_event, context) => {
			context.status?.replace("Working...");
		},
		"todo.changed": (event, context) => {
			context.status?.setTodo(event.text);
		},
	};
}

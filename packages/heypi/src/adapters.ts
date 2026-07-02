import type { Adapter, AdapterContext, ChatMessage, SendMessage } from "./types.js";

export type LocalAdapter = Adapter & {
	receive(message: Omit<ChatMessage, "adapter" | "account" | "conversation"> & Partial<ChatMessage>): Promise<void>;
	sent: SendMessage[];
};

export function local(name = "local"): LocalAdapter {
	let context: AdapterContext | undefined;
	const sent: SendMessage[] = [];
	return {
		kind: "local",
		name,
		sent,
		start(nextContext) {
			context = nextContext;
		},
		async send(message) {
			sent.push(message);
			return { id: `local-${sent.length}` };
		},
		async receive(message) {
			if (!context) throw new Error("Local adapter is not started");
			await context.receive({
				adapter: "local",
				account: "local",
				conversation: "local",
				...message,
			});
		},
	};
}

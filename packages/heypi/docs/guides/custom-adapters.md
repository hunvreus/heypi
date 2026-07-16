# Create a custom adapter

An adapter receives external events, converts them to `ChatMessage`, and delivers normalized heypi
output back to the same service.

```ts
import type { Adapter, AdapterContext, ChatMessage, SendMessage } from "@hunvreus/heypi";

export type InternalAdapter = Adapter & {
	receive(message: ChatMessage): Promise<void>;
};

export function internal(deliver: (message: SendMessage) => Promise<string>): InternalAdapter {
	let context: AdapterContext | undefined;
	return {
		kind: "internal",
		id: "internal",
		start(next) {
			context = next;
		},
		async receive(message) {
			if (!context) throw new Error("Adapter is not started");
			await context.receive(message);
		},
		async send(message) {
			const id = await deliver(message);
			return { id };
		},
	};
}
```

Use stable message, user, conversation, thread, and adapter IDs. Authenticate input before calling
`context.receive()`, mark self-authored events with `user.isSelf`, and clean up resources in `stop()`.

Implement optional boundaries only when supported:

- `update()` for editable todo messages.
- `materializeAttachments()` for authenticated inbound downloads.
- `requestApproval()` for native approval UI; otherwise approval fails closed.
- `events` for platform-specific activity and lifecycle rendering.

See the exported `Adapter`, `AdapterContext`, and `ChatMessage` types for the complete contract.

# Local

The local adapter is an in-process transport for tests, embedding, and development tools. It does
not open a network listener.

```ts
import { local, runHeypi } from "@hunvreus/heypi";

const chat = local();
const app = await runHeypi(agent, [chat]);

await chat.receive({
	id: "message-1",
	user: { id: "developer", name: "Developer" },
	text: "Inspect the workspace.",
});

console.log(chat.sent);
await app.stop();
```

Local messages default to conversation `local`, `dm: true`, and `mentioned: true`. Supply stable
conversation, session, thread, or reply IDs to test routing behavior.

The adapter stores outbound messages in `sent` and supports updates for todo rendering. It uses
shared busy and todo event defaults but has no native typing, status, attachment download, or
interactive approval UI.

Use the local adapter only within a trusted process. It does not authenticate callers or create a
sandbox; execution safety comes from the agent runtime.

# Memory

heypi enables a curated memory extension by default. It is not a transcript archive and it does not
silently inject broad chat history.

## Tools

- `memory` adds, replaces, or removes a durable record.
- `memory_search` performs explicit recall across records visible to the active conversation.

Records have one destination:

- `conversation`: local to the active chat surface and used by default;
- `user`: scoped to the active user on the adapter;
- `shared`: reusable across conversations for that adapter.

The extension adds a small relevant snapshot through Pi's context event without changing the
session transcript. Explicitly recalled text is fenced as untrusted reference context.

Different users in one public thread retain separate user memories. Shared memory is isolated by
adapter ID, so two Slack workspaces configured as separate adapters do not share it.

Disable memory when the agent does not need durable recall:

```ts
const agent = loadAgent("./agent", { memory: false });
```

Memory files live under the configured state directory. Treat them as application data and include
them in the same retention and backup policy as conversation records.

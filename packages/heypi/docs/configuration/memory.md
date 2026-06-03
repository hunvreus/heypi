# Memory

Memory is small durable background context, not a transcript database or trusted config. It is off by default.

## Config

```ts
createHeypi({
	state: { root: "./state" },
	// ...adapters, agent, runtime
	scope: "channel",
	memory: {
		enabled: true,
		scope: "user",
		writePolicy: "approvers",
		maxChars: 4000,
	},
});
```

`memory.scope` defaults to the top-level [`scope`](scope.md).

## Options

| Option | Required | Default | Description |
| --- | --- | --- | --- |
| `enabled` | No | `false` | Enables memory tools and context injection. |
| `scope` | No | Top-level [`scope`](scope.md) | Memory sharing boundary. |
| `writePolicy` | No | See [Write policy](#write-policy) | Who can mutate memory. |
| `maxChars` | No | `4000` | Maximum memory file size. |

## Behavior

When enabled, heypi:

1. reads the scoped memory file,
2. injects it as background context,
3. exposes `memory_read`, `memory_write`, `memory_replace`, and `memory_delete`,
4. allows mutation according to `memory.writePolicy`,
5. validates memory writes for size, obvious secrets/private keys, and prompt-injection-shaped text.

Good memory:

```md
- This channel is for production incidents.
- Deploy approvals require Alice or Bob.
- The staging API lives at https://staging.example.com.
```

Bad memory:

```md
- Full chat logs.
- Temporary task state.
- Secrets or tokens.
- Untrusted instructions copied from random users.
```

Write validation is a hygiene check, not a security boundary. Do not store secrets, credentials, private data, or policy rules that must be trusted.

## Scope

Memory scopes:

- `channel`: every user in the chat can share memory.
- `user`: each actor gets separate memory.
- `adapter`: every accepted chat on the adapter shares memory.
- `agent`: every adapter for this configured agent shares memory.

DMs use the same rules as other chats: `channel` memory follows the provider chat/channel id, while `user` memory follows the actor id.

## Write policy

`writePolicy` controls mutation:

- `auto`: the agent can write, replace, and delete memory.
- `approvers`: only turns initiated by configured approver users or groups can mutate memory.
- `off`: memory can be read and injected, but cannot be changed.

Defaults:

- when `approval.approvers` is configured: `approvers`.
- without approvers, `channel` and `user`: `auto`.
- without approvers, `adapter` and `agent`: `off`.

When memory is enabled, heypi logs the memory scope and write policy at startup. `adapter` and `agent` scopes are logged as warnings because they let one chat affect future answers elsewhere.

Approvals do not elevate actor identity. If a non-approver starts a turn and an approver later approves one of its tool calls, the continued turn still belongs to the original requester for `memory.writePolicy` checks.

Concurrent writes use the filesystem as the source of truth. Avoid concurrent writes to the same scope; no merge is attempted.

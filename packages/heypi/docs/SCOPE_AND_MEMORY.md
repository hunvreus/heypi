# Scope And Memory

Use scope settings to control which chats and users share runtime files, attachments, and long-lived memory.

heypi exposes one workspace/runtime scope and an optional memory scope:

```ts
createHeypi({
	state: { root: "./state" },
	// ...adapters, agent
	scope: "channel", // default: "channel" | "user" | "adapter" | "agent"
	runtime: {
		root: "./workspace",
		// scope: "user", // optional override; defaults to top-level scope
	},
	memory: {
		enabled: true,
		scope: "user",
		writePolicy: "approvers",
		maxChars: 4000,
	},
});
```

`scope` controls the shared tool workspace, generated files, and attachments:

- `channel`: one workspace per chat channel.
- `user`: one workspace per chat actor.
- `adapter`: one workspace per configured adapter instance.
- `agent`: one workspace across adapters for this configured agent.

Pi sessions, chat history, approvals, and active-run locks remain per thread. That keeps the conversation model predictable while still giving channels or users a shared working area.

`memory.scope` controls the memory file independently and defaults to the top-level `scope`. That allows shared channel files with per-user memory, or per-user files with shared channel memory.

## Choosing Scopes

Common configurations:

```ts
// Shared files and shared memory per channel.
createHeypi({
	state: { root: "./state" },
	// ...adapters, agent, runtime
	scope: "channel",
	memory: true,
});
```

```ts
// Shared channel files, but each user gets separate memory.
createHeypi({
	state: { root: "./state" },
	// ...adapters, agent, runtime
	scope: "channel",
	memory: { enabled: true, scope: "user" },
});
```

```ts
// Each user gets separate files and memory.
createHeypi({
	state: { root: "./state" },
	// ...adapters, agent, runtime
	scope: "user",
	memory: true,
});
```

Use `adapter` or `agent` only when you want memory or files shared across multiple chats. Those scopes can let one conversation affect another.

## Runtime And Attachment Layout

Scoped runtime roots and attachment roots both live under the configured runtime root, but they are separate trees:

```text
workspace/
  scopes/
    channel/<agent>/<provider>/<team>/<channel>/
    user/<agent>/<provider>/<team>/<actor>/
    adapter/<agent>/<provider>/
    agent/<agent>/
  attachments/
    scopes/
      channel/<agent>/<provider>/<team>/<channel>/
```

Path segments are encoded before they are used on disk.

Runtime workspaces follow `runtime.scope ?? scope`. Memory follows `memory.scope ?? scope`. Attachments follow the top-level `scope`; there is no separate `attachments.scope` setting. Attachment refs are resolved only against the current scope, so a channel-scoped app cannot use a file uploaded in another channel and a user-scoped app cannot use another user's uploaded file.

Host-based runtimes (`host-bash`, `guarded-bash`) are still not a hard filesystem sandbox. Use `just-bash` for team-facing agents.

## Memory

Memory is small durable background context, not a transcript database or trusted config.

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

When enabled, heypi:

1. reads the scoped memory file,
2. injects it as background context,
3. exposes `memory_read`, `memory_write`, `memory_replace`, and `memory_delete`,
4. allows mutation according to `memory.writePolicy`,
5. validates memory writes for size, obvious secrets/private keys, and prompt-injection-shaped text.

Validation is a hygiene check, not a security boundary. Do not store secrets, credentials, private data, or policy rules that must be trusted.

Memory scopes:

- `channel`: every user in the chat can share memory.
- `user`: each actor gets separate memory.
- `adapter`: every accepted chat on the adapter shares memory.
- `agent`: every adapter for this configured agent shares memory.

DMs use the same rules as other chats: `channel` memory follows the provider chat/channel id, while `user` memory follows the actor id. In a one-to-one DM these often feel equivalent, but they remain separate paths.

`writePolicy` controls mutation:

- `auto`: the agent can write, replace, and delete memory.
- `approvers`: only turns initiated by `approval.approvers` can mutate memory.
- `off`: memory can be read and injected, but cannot be changed.

Defaults:

- when `approval.approvers` is configured: `approvers`.
- without approvers, `channel` and `user`: `auto`.
- without approvers, `adapter` and `agent`: `off`.

When memory is enabled, heypi logs the memory scope and write policy at startup. `adapter` and `agent` scopes are logged as warnings because they let one chat affect future answers elsewhere. `channel` + `auto` still lets one channel user affect future answers for other users in that channel. Treat memory like a shared bot-maintained note, not a security boundary.

Concurrent writes use the filesystem as the source of truth. If two writes race in the same scope, the later write can win.

### Approvals And Memory Writes

Approvals do not elevate actor identity. If a non-approver starts a turn and an approver later approves one of its tool calls, the continued turn still belongs to the original requester for `memory.writePolicy` checks.

For team memory where only leads should teach the bot, configure `approval.approvers` and leave `memory.writePolicy` unset. It will default to `approvers`. Do not model memory writes as normal approved tool calls unless you intentionally want approval to govern execution while memory policy still checks the original requester.

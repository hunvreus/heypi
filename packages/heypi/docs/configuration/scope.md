# Scope

Scope controls which chats and users share runtime workspace files, attachments, memory, and skills.

## Config

```ts
createHeypi({
  state: { root: "./state" },
  // ...adapters, agent
  scope: "channel", // default: "channel" | "user" | "adapter" | "agent"
  runtime: {
    root: "./workspace",
    // scope: "user", // optional runtime/workspace override
  },
  memory: {
    enabled: true,
    scope: "user", // optional memory override
  },
  skills: {
    enabled: true,
    scope: "channel", // optional skills override
  },
});
```

## Options

| Option | Required | Default | Description |
| --- | --- | --- | --- |
| `scope` | No | `"channel"` | Default scope for scoped features. |
| `runtime.scope` | No | Top-level `scope` | Runtime workspace override. |
| `memory.scope` | No | Top-level `scope` | Memory override. |
| `skills.scope` | No | Top-level `scope` | Skills override. |

## Levels

- `channel`: one scope per Slack channel, Telegram chat, Discord channel, or webhook channel.
- `user`: one scope per chat actor.
- `adapter`: one scope per configured adapter instance.
- `agent`: one scope across adapters for this configured agent.

Sessions, chat history, approvals, and active-run locks remain per thread. Scope controls shared working context, not the conversation identity.

Use `adapter` or `agent` only when you intentionally want one conversation to affect another through shared files, memory, or skills.

## Overrides

The top-level `scope` is the default for scoped features:

- Runtime workspaces follow `runtime.scope ?? scope`.
- Memory follows `memory.scope ?? scope`.
- Skills follow `skills.scope ?? scope`.
- Attachments follow the top-level `scope`; there is no separate `attachments.scope`.

This lets you combine shared channel files with per-user memory, or per-user workspaces with shared channel skills.

## Layout

Scoped data lives under the configured runtime root:

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
  memory/
    scopes/
      channel/<agent>/<provider>/<team>/<channel>/memory.md
  skills/
    scopes/
      channel/<agent>/<provider>/<team>/<channel>/<skill>/SKILL.md
```

Secret handoffs are written into the active runtime workspace as `.secrets/<name>`, so they follow runtime scope rather than memory or skills scope.

Path segments are encoded before they are used on disk.

Attachment refs are resolved only against the current scope. A channel-scoped app cannot use an attachment uploaded in another channel, and a user-scoped app cannot use another user's uploaded file.

The built-in `attach` tool uses the active runtime scope, so generated files are uploaded only from the current scoped workspace.

Host-based runtimes (`host-bash`, `guarded-bash`) are not hard filesystem sandboxes. Use `just-bash`, Docker, or Gondolin for team-facing isolation.

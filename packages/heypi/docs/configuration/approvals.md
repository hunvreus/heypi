# Approvals

Approvals pause pending tool calls until an authorized actor approves or denies them in chat.

## Config

```ts
createHeypi({
  approval: {
    expiresInMs: 30 * 60_000,
    allowSelfApproval: true,
    bypass: {
      durationMs: 5 * 60_000,
      maxDurationMs: 15 * 60_000,
      scope: "thread",
    },
  },
  adapters: [
    slack({
      // ...Slack auth and delivery config
      permissions: {
        approvers: { users: ["U123"], groups: ["S123"] },
        admins: { users: ["U999"] },
      },
    }),
  ],
  // ...state, agent, runtime
});
```

## Options

`approval` controls approval behavior. Adapter `permissions` controls who can approve for that adapter.

| Option | Required | Default | Description |
| --- | --- | --- | --- |
| `expiresInMs` | No | No expiry | Milliseconds before a pending approval expires. |
| `allowSelfApproval` | No | `true` | Whether a requester who is also an approver/admin can approve their own request. |
| `bypass` | No | Disabled | `false` disables bypasses. An object enables temporary approval bypasses. |

`bypass` options:

| Option | Required | Default | Description |
| --- | --- | --- | --- |
| `durationMs` | No | `300_000` | Duration granted by an approval bypass decision. |
| `maxDurationMs` | No | `900_000` | Upper bound for any bypass duration. |
| `scope` | No | `thread` | Where the requester actor's bypass applies: `thread`, `channel`, `user`, or `adapter`. |

Bypasses are actor-bound. A `thread` bypass lets the same requester skip approval in that thread until expiry; it does not let other actors in the thread skip approval.

Adapter `permissions.approvers` and `permissions.admins` accept either an array of user IDs or `{ users, groups }`. Admins inherit approver permissions. Group support depends on the adapter: Slack uses user group IDs, Discord uses role IDs, Telegram has no shared group concept, and webhook permissions use caller-provided user IDs.

## Approval controls

Approval buttons are the primary control surface where the adapter supports them.

Typed fallback commands are provider-specific. Slack uses `/heypi` subcommands, Discord and Telegram use native commands, and webhook/internal adapters can send trusted text commands:

```text
/approvals
/bypasses
/approve <approval-id>
/approve <approval-id> bypass
/deny <approval-id>
/revoke <bypass-id>
```

In Telegram groups, use bot-qualified commands such as `/approve@YourBotName <approval-id>` when needed. In Slack, use `/heypi approve <approval-id>` instead of `/approve`. Natural language approval text is treated as a normal agent prompt, not as an approval decision.

In chat, `/approvals` lists pending approvals for the current channel. Use the admin UI or `heypi approvals list` for cross-channel inspection.

## How calls become approvals

`approval` does not make every tool call require approval. Tool confirmation does that:

- [`approval.command()`](tools.md#confirmation) controls bash risk policy.
- Custom tools can return a confirmation object from [`confirm`](tools.md#confirmation).
- Managed tools such as memory and skills use their own write policies.

See [Agent tools: Confirmation](tools.md#confirmation) for the `confirm` return shape and examples.

## Notes

- Approval decisions are logged with the requester, approver, call, tool, and result.
- Without configured adapter approvers or admins, human approvals are limited by thread visibility, not by a central allowlist. Configure explicit adapter permissions for shared or team-facing bots.
- `allow.bots` lets bots send messages to the agent. It does not let bots list, approve, deny, or revoke approvals unless the bot actor is explicitly listed in adapter `permissions.approvers` or `permissions.admins`.
- Users can deny their own requested approval.
- Human requesters can approve their own pending request when they are authorized by the zero-config fallback or by adapter permissions, unless `allowSelfApproval` is disabled.
- Pending approvals are persisted. On startup, heypi fails stale running calls and requeues stale running job runs from a previous process so they do not stay stuck in `running`.

heypi logs a startup warning when bash or confirmed custom tools are enabled without explicit adapter approvers or admins.

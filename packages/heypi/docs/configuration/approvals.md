# Approvals

Approvals pause pending tool calls until an authorized actor approves or denies them in chat.

## Config

```ts
createHeypi({
	approval: {
		approvers: { users: ["U123"], groups: ["SRE"] },
		admins: ["U999"],
		expiresInMs: 30 * 60_000,
		allowSelfApproval: true,
	},
	// ...state, adapters, agent, runtime
});
```

## Options

| Option | Required | Default | Description |
| --- | --- | --- | --- |
| `approvers` | No | Thread/channel visibility | Users or provider groups allowed to list and resolve approvals. |
| `admins` | No | `[]` | Users or provider groups allowed to use approval controls; admins inherit approver permissions. |
| `expiresInMs` | No | No expiry | Milliseconds before a pending approval expires. |
| `allowSelfApproval` | No | `true` | Whether a requester who is also an approver/admin can approve their own request. |

`approvers` and `admins` accept either an array of user IDs or `{ users, groups }`. Group support depends on the adapter: Slack uses user group IDs, Discord uses role IDs, and Telegram has no shared group concept.

## Chat commands

Control commands use strict slash syntax:

```text
/approvals
/approve <approval-id>
/deny <approval-id>
```

Natural language approval text is treated as a normal agent prompt, not as an approval decision.

## How calls become approvals

`approval` does not make every tool call require approval. Tool confirmation does that:

- [`commandConfirm()`](tools.md#confirmation) controls bash risk policy.
- Custom tools can return a confirmation object from [`confirm`](tools.md#confirmation).
- Managed tools such as memory and skills use their own write policies.

See [Agent tools: Confirmation](tools.md#confirmation) for the `confirm` return shape and examples.

## Notes

- Approval decisions are logged with the requester, approver, call, tool, and result.
- Without `approvers` or `admins`, approvals are limited by thread visibility, not by a central allowlist. Configure explicit approval actors for shared or team-facing bots.
- Users can deny their own requested approval.
- Requesters can approve their own pending request only if they are also an approver/admin and `allowSelfApproval` is not disabled.

heypi logs a startup warning when bash or confirmed custom tools are enabled without explicit `approval.approvers` or `approval.admins`.

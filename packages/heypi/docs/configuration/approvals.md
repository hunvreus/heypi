# Approvals

Approvals pause pending tool calls until an authorized actor approves or denies them in chat.

## Config

```ts
createHeypi({
	approval: {
		approvers: { users: ["U123"], groups: ["SRE"] },
		expiresInMs: 30 * 60_000,
	},
	// ...state, adapters, agent, runtime
});
```

## Options

| Option | Required | Default | Description |
| --- | --- | --- | --- |
| `approvers` | No | Thread/channel visibility | Users or provider groups allowed to list and resolve approvals. |
| `expiresInMs` | No | No expiry | Milliseconds before a pending approval expires. |

`approvers` accepts either an array of user IDs or `{ users, groups }`. Group support depends on the adapter: Slack uses user group IDs, Discord uses role IDs, and Telegram has no shared group concept.

## How calls become approvals

`approval` does not make every tool call require approval. Tool confirmation does that:

- [`commandConfirm()`](tools.md#confirmation) controls bash risk policy.
- Custom tools can return a confirmation object from [`confirm`](tools.md#confirmation).
- Managed tools such as memory and skills use their own write policies.

See [Agent tools: Confirmation](tools.md#confirmation) for the `confirm` return shape and examples.

## Notes

- Approval decisions are logged with the requester, approver, call, tool, and result.
- Without `approvers`, approvals are limited by thread visibility, not by a central allowlist.
- Users can deny their own requested approval.

# Chat behavior

`chat` controls what happens when a new message arrives while a thread already has an active run.

## Config

```ts
createHeypi({
	chat: { busy: "steer" },
	// ...state, adapters, agent, runtime
});
```

## Options

| Option | Required | Default | Description |
| --- | --- | --- | --- |
| `busy` | No | `"steer"` | Same-thread behavior while a run is active. |

`busy` values:

| Value | Behavior |
| --- | --- |
| `"steer"` | Pass the new message to the current run as additional context. |
| `"followUp"` | Acknowledge the message and queue it as a follow-up. |
| `"reject"` | Reply that the thread is busy. |

## Messages

`messages` is top-level app config shown here because busy replies are one of the most common values to customize. It also controls errors, approval copy, cancellation copy, and runtime startup/failure text:

```ts
createHeypi({
	messages: {
		busySteer: "Got it. I'll include that.",
		error: "Something went wrong. Ask an admin to check logs.",
		runtimeStarting: "Preparing runtime...",
	},
	// ...state, adapters, agent, runtime
});
```

Set `runtimeStarting: false` to suppress runtime startup progress text.

### Message keys

| Key | Default |
| --- | --- |
| `error` | `Something went wrong. Ask an admin to check the server logs.` |
| `busyReject` | `I'm still working on the previous message. Send this again after I reply, or use \`cancel\`.` |
| `busyFollowUp` | `Got it. I'll handle that next.` |
| `busySteer` | `Got it. I'll include that.` |
| `pendingApprovalReject` | `I'm waiting for the pending approval first.` |
| `approvalUnavailable` | `Approval unavailable. Ask me to try again if this is still needed.` |
| `approvalAlreadyResolved` | Function receiving `{ state, resolvedBy }`; returns `Approval already <state> by <resolvedBy>.` |
| `approvalResolved` | `Approval already resolved.` |
| `approvalExpired` | `Approval expired. Ask me to try again if this is still needed.` |
| `approvalUnauthorized` | `You are not allowed to resolve this action.` |
| `cancelled` | `Cancelled.` |
| `cancelUnauthorized` | `You are not allowed to cancel this run.` |
| `cancelNotFound` | `No active run found for that id.` |
| `approvalsUnauthorized` | `You are not allowed to view pending approvals.` |
| `runtimeStarting` | `Preparing runtime...` |
| `runtimeFailed` | `Runtime failed. Ask an admin to check the server logs.` |

## Related

- [Adapters](../adapters/index.md) for provider-specific delivery behavior.
- [Approvals](approvals.md) for approval and control commands.

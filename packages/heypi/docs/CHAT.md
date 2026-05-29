# Chat Behavior

Slack, Telegram, and Discord share the same chat behavior after a provider event is accepted.

## Access And Triggers

Provider setup decides which events heypi can receive. The adapter `allow` config only filters events after delivery.

Defaults:

- omitted `allow` accepts all delivered events
- omitted team/chat/channel/user lists accept all delivered events for that dimension
- `dms` defaults to `true`; set `dms: false` to drop DMs
- `trigger` defaults to `"mention"` in top-level groups/channels
- `trigger: "message"` runs the agent for every allowed group/channel message
- accepted DMs always run the agent
- thread/topic replies default to message-triggered follow-ups
- set `threadTrigger: "mention"` to require mentions in thread/topic replies

`allow.users` controls who may talk to the bot. `approval.approvers` controls who may approve tool calls. `jobs.scope` and `jobs.targets` only affect scheduled outbound jobs.

## Streaming And Progress

Streaming is opt-in:

```ts
slack({ /* ... */ streaming: true });
```

Use `true` for sensible defaults, or pass `{ intervalMs, minChars, maxFailures }` to tune draft edits.

Progress defaults to `Working...`. Set `progress: false` to disable it. Slow runtime providers can update the temporary progress message during cold start with `messages.runtimeStarting`, which defaults to `Preparing runtime...` and can be set to `false`. Confirmed tool calls stop draft streaming before approval UI is sent.

Provider differences:

- Slack still posts the progress message while streaming; top-level channel messages also get the configured reaction.
- Telegram and Discord suppress progress messages while streaming to avoid duplicate visible replies.

## Busy Threads

Same-thread messages while a turn is active use `chat.busy`:

- `steer`: default; inject the message into the active Pi session
- `followUp`: add it after the active assistant response settles
- `reject`: ask the user to send it again later

For `steer` and `followUp`, heypi stores the inbound message, publicly acknowledges it, keeps the original progress marker as a temporary anchor, deletes that marker at completion, and posts the final answer at the bottom of the thread.

Pending approvals reject new asks until the approval is approved or denied.

## System Messages

Provider labels, card headings, button text, and help text are fixed. Bot outcome copy is configurable with top-level `messages`:

```ts
createHeypi({
	state: { root: "./state" },
	// ...adapters, agent, runtime
	chat: { busy: "steer" },
	messages: {
		busySteer: "Got it. I'll include that.",
		busyFollowUp: "Got it. I'll handle that next.",
		busyReject: "I'm still working on the previous message. Send this again after I reply, or use `cancel`.",
		pendingApprovalReject: "I'm waiting for the pending approval first.",
		approvalUnavailable: "Approval unavailable. Ask me to try again if this is still needed.",
		approvalAlreadyResolved: ({ state, resolvedBy }) => `Approval already ${state} by ${resolvedBy ?? "unknown"}.`,
		approvalResolved: "Approval already resolved.",
		approvalExpired: "Approval expired. Ask me to try again if this is still needed.",
		approvalUnauthorized: "You are not allowed to resolve this action.",
		cancelled: "Cancelled.",
		cancelUnauthorized: "You are not allowed to cancel this run.",
		cancelNotFound: "No active run found for that id.",
		approvalsUnauthorized: "You are not allowed to view pending approvals.",
		runtimeStarting: "Preparing runtime...", // set false to keep the adapter's normal progress text
		runtimeFailed: "Runtime failed. Ask an admin to check the server logs.",
		error: "Something went wrong. Ask an admin to check the server logs.",
	},
});
```

## Approvals And Cancel

Text commands work in every chat adapter:

```text
approvals
approve <approval-id>
deny <approval-id>
status
status <call-id>
cancel <turn-id-or-trace>
```

Slack, Telegram, and Discord also render native approval buttons. Approve/reject actions edit the original approval message, keep the approval details visible, and remove the buttons. Stale approval buttons also replace the original message with an unavailable/already-resolved notice.

Approval cards show a reason plus optional structured details. Details are label/value fields; code details render as code blocks where the provider supports it. Details are capped centrally to stay within provider card limits. The shared runtime supplies core bash command details, and custom tools can provide domain-specific fields such as target host, service, or request scope.

Permissions:

- `approve`: configured `approval.approvers`, or open if none are configured
- `deny`: configured approvers or the original requester
- `cancel`: run initiator or configured approvers
- `approvals`: configured approvers, or current-thread-only when no approvers are configured

Unauthorized button actions get private provider-native feedback where the provider supports it.

## Delivery

Adapter sends are serialized by default. Provider rate limits are retried with backoff. Ambiguous timeouts are not retried for non-idempotent sends such as new messages or file uploads.

Most apps should keep the defaults. If a provider needs slower pacing, set `delivery: { intervalMs: 500 }`; use `delivery: false` only for development or custom transport control.

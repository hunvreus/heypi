# Approvals

Approvals run at the Pi tool-call boundary. A policy decides whether a call may run, must be approved,
or must be blocked. The active adapter decides who may respond and how the request is rendered.
Approvals are opt-in per tool; configuring approvers alone does not make tools require approval.

```ts
const agent = loadAgent("./agent", {
	tools: {
		bash: {
			approve: approval.when(
				({ actor }) => actor?.id !== "U_ADMIN",
				"Run a shell command.",
			),
		},
	},
});
```

## Policies

- `approval.never()` allows every call.
- `approval.always(reason)` asks every time.
- `approval.once(reason)` asks once per tool in a Pi session.
- `approval.when(predicate, reason)` asks when the predicate matches.
- `approval.command(config)` classifies shell commands with `allow`, `approve`, and `block` patterns.

Predicates receive the tool name, input, adapter, conversation, thread, actor, and tools already
approved in the session. They do not receive the complete transcript or platform history.

## Approvers

```ts
slack({
	token,
	appToken,
	admins: { users: ["U_ADMIN"] },
	approvers: { users: ["U_DEPLOYER"] },
	approvals: { layout: "card", timeoutMs: 60_000, showId: false },
});
```

Admins can always approve. Slack and Telegram match user IDs; Discord also supports role IDs.
Built-in adapters do not resolve generic external groups. If `admins` and `approvers` are both
omitted, any actor who can reach the approval UI may respond; heypi logs a startup warning.

## Guarantees

heypi records `approval_requested` before posting UI and `approval_resolved` before continuing the
tool. If either canonical write fails, the call is blocked. Rejection, timeout, missing adapter UI,
and process shutdown also fail closed.

`layout: "message"` uses compact text and buttons. `layout: "card"` uses Slack attachments or
Discord embeds; Telegram uses text with inline buttons.

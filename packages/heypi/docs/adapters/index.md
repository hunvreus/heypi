# Adapters

Adapters normalize chat services into one message contract and render replies, activity, approvals,
todos, and attachments through native platform APIs.

| Adapter | Transport | Default trigger |
| --- | --- | --- |
| `local()` | In-process | Every received message |
| `webhook()` | HTTP | Every authenticated request |
| `slack()` | Socket Mode | DMs and app mentions |
| `discord()` | Gateway | DMs and bot mentions |
| `telegram()` | Long polling | DMs and bot mentions |

Supported thread or reply-chain follow-ups continue the originating Pi session without another
mention. Bot self-messages never trigger a turn; other bots are controlled by `allow.bots`.

## Shared options

- `id`: stable storage and routing identity.
- `allow`: DM, channel, user, group, and bot filters.
- `admins`: actors with administrative and approval privileges.
- `approvers`: additional actors who may answer approvals.
- `approvals`: native layout and timeout.
- `busy`: `queue`, `steer`, or `reject` while a conversation is active.
- `events`: override or disable normalized adapter event handlers.

Slack uses native assistant status; Discord and Telegram refresh native typing indicators. These
surfaces can be disabled with `status: false` or `typing: false`. Slack mention reactions are
configured through `reaction`.

Inbound files are materialized under the active conversation workspace. Outbound files use
`chat_attach` and native upload APIs when supported.

Configure inbound attachment limits per adapter:

```ts
slack({
	// credentials omitted
	attachments: {
		maxBytes: 20 * 1024 * 1024,
		mimeTypes: ["image/*", "application/pdf", "text/plain"],
	},
});
```

Built-in adapters restrict downloads to their service hosts by default. `hosts` replaces that
allowlist, including redirect destinations. Downloads use bounded retries; Telegram also honors API
rate-limit retry metadata and bounds API requests with `timeoutMs`.

Use the [custom adapter guide](../guides/custom-adapters.md) for another transport.

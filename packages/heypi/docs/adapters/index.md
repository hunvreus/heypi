# Adapters

Adapters connect heypi to chat providers and trusted HTTP callers. They turn provider events into heypi turns, then send replies, progress updates, approvals, and attachments back through the same provider.

Pick the adapter that matches where the agent should be reachable:

| Adapter | Use it for |
| --- | --- |
| [Slack](slack.md) | Team channels, DMs, files, threads, approval buttons, Socket mode, or signed HTTP delivery. |
| [Discord](discord.md) | Guild channels, DMs, threads, attachments, streaming edits, and approval buttons. |
| [Telegram](telegram.md) | DMs, groups, channels, forum topics, attachments, and callback buttons. |
| [Webhook](webhook.md) | Trusted internal systems that call heypi over JSON HTTP. |

## Shared behavior

Provider permissions run first. heypi only sees events the provider delivers to the bot.

After that, adapter config decides which events become turns:

- `allow.users` and `allow.groups` match actor access where the provider supports groups.
- `allow.channels`, `allow.chats`, or webhook channel values match the conversation.
- `allow.dms` controls direct messages separately from channel/chat allowlists.
- `allow.bots` lets selected bot actors send messages where supported. Avoid bot-to-bot chains that auto-reply to each other; heypi drops only its own bot identity, not every peer bot.
- Channels and groups default to `trigger: "mention"`; DMs run accepted messages directly.
- Threads, topics, and replies default to `threadTrigger: "message"` once a turn has been created in that thread.
- `streaming: true` enables draft edits where supported.
- `task.busy` controls messages that arrive while a turn is active: `steer`, `followUp`, or `reject`.

Shared control commands:

```text
/approvals
/approve <approval-id>
/approve <approval-id> bypass
/deny <approval-id>
/revoke <bypass-id>
/status
/status <call-id>
/cancel <turn-id-or-trace>
```

For shared workspaces, configure `allow`. Without it, any delivered DM can trigger the agent, and any delivered channel or group message can trigger it by mention or control command. heypi logs a startup warning when a built-in chat adapter starts without an allow filter.

## Provider differences

| Provider | Main difference |
| --- | --- |
| Slack | Socket mode for local/dev, signed HTTP for production-style inbound delivery. `allow.groups` uses Slack user group IDs. |
| Discord | Gateway event adapter. `allow.groups` uses role IDs. |
| Telegram | Long polling adapter. User access has no shared group/role concept. |
| Webhook | Inbound-only JSON adapter. Scheduled jobs cannot target webhook adapters. |

## Delivery

Adapter sends are serialized by default. Provider rate limits are retried with backoff. Ambiguous send timeouts are not retried for non-idempotent sends such as new messages or file uploads.

Most apps should keep the default `delivery: { intervalMs: 0 }`. Set a higher `intervalMs` only when a provider needs slower pacing.

## Custom adapters

Custom adapters implement `Adapter` from `@hunvreus/heypi/adapter` and can live in separate packages. Built-in adapters are concrete integrations, not subclassable base classes.

# Adapters

Adapters connect heypi to chat providers and trusted HTTP callers. They turn provider events into heypi turns, then send replies, progress updates, approvals, and attachments back through the same provider.

Pick the adapter that matches where the agent should be reachable:

| Adapter | Use it for |
| --- | --- |
| [Slack](slack.md) | Team channels, DMs, files, threads, approval buttons, Socket mode, or signed HTTP delivery. |
| [Discord](discord.md) | Guild channels, DMs, threads, attachments, streaming edits, and approval buttons. |
| [Telegram](telegram.md) | DMs, groups, supergroups, forum topics, attachments, scheduled delivery to chat IDs, and callback buttons. |
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

Approval buttons are the primary approval controls where supported. Typed command fallback is provider-specific:

```text
/approvals
/bypasses
/approve <approval-id>
/approve <approval-id> bypass
/deny <approval-id>
/revoke <bypass-id>
/status
/status <call-id>
/cancel <turn-id-or-trace>
```

Slack uses the native `/heypi` command with subcommands such as `/heypi approve <approval-id>`. Slack slash command names are workspace-global, so use a unique command name if multiple heypi apps share one workspace. Discord uses flat native application commands such as `/approve` and `/status`. Telegram keeps bot commands such as `/approve`.

In chat, `/approvals` lists approvals for the current channel. Use the admin UI or CLI approvals commands for cross-channel views.

For shared workspaces, configure `allow`. Without it, any delivered DM can trigger the agent, and any delivered channel or group message can trigger it by mention or control command. heypi logs a startup warning when a built-in chat adapter starts without an allow filter.

## Adapter boundary

Adapters are operational wiring. Keep them explicit in the app entrypoint because they own credentials, provider verification, routing policy, and deployment shape. File discovery is the default for agent-authored behavior such as instructions, tools, jobs, skills, and evals; it is not the default for adapters.

Built-in adapters provide verified ingress, provider normalization, scoped reply delivery, approvals, progress updates, and attachment delivery. They should not become broad model-callable provider clients. If the agent needs to call a domain action, put that action in a project-owned tool under `agent/tools/`.

For example, use `slack()` to receive a Slack mention and reply to the same thread. Do not expose a generic `slack_api` tool that lets the model call arbitrary Slack methods or choose arbitrary channels. If the app needs one outbound action, define a narrow tool such as `page_on_call` or `post_incident_summary` that validates its inputs and sends only to the configured destination.

Thread and channel ids are stable routing identifiers, not proof of authorization. A stored Slack thread like `C123:1719000000.000100` tells heypi where replies belong; it does not prove the current caller may act as that thread. Direct admin, webhook, or custom routes that accept caller-selected thread ids must authenticate the caller and apply their own authorization before continuing the thread.

Keep short-lived provider capabilities out of model input, persisted state, and logs. Slack `trigger_id` values, Slack response URLs, Discord interaction tokens, and similar callback credentials should be used only inside the adapter response path. Persist stable ids such as channel id, user id, message id, thread timestamp, event id, and run id. When a provider gives only a short-lived value for retry correlation, derive a non-reversible internal id from it and persist the derived id, not the raw value.

## Provider differences

| Provider | Main difference |
| --- | --- |
| Slack | Socket mode for local/dev, signed HTTP for production-style inbound delivery. `allow.groups` uses Slack user group IDs. |
| Discord | Gateway event adapter. `allow.groups` uses role IDs. |
| Telegram | Long polling or webhook adapter. User access has no shared group/role concept. |
| Webhook | Inbound-only JSON adapter. Scheduled jobs cannot target webhook adapters. |

## Delivery

Adapter sends are serialized by default. Provider rate limits are retried with backoff. Ambiguous send timeouts are not retried for non-idempotent sends such as new messages or file uploads.

Most apps should keep the default `delivery: { intervalMs: 0 }`. Set a higher `intervalMs` only when a provider needs slower pacing.

Inbound provider retries are deduped when the adapter supplies a stable provider event id for the stored thread. This prevents a retried Slack event, Discord message, Telegram update, or webhook request from starting the same turn twice after the first copy is recorded. It does not make external side effects idempotent: if a custom tool deploys code, charges money, or writes to another system, that tool still needs its own idempotency key or approval policy.

Example: a retried Slack message with timestamp `1719000000.000100` in thread `C123:1719000000.000100` is stored once. If the agent then calls `deploy_production`, that tool still needs its own deploy idempotency key, because heypi cannot know whether the external deployment system completed before a crash.

## Inbound dedupe keys

| Adapter | Dedupe key |
| --- | --- |
| Slack messages | Slack `client_msg_id` when present, otherwise message `ts`. |
| Slack slash commands | Internal hash derived from command name, team, channel, user, text, and Slack `trigger_id`; the raw `trigger_id` is not persisted. |
| Slack buttons/actions | heypi action trace derived from the action value or message id. Approval state handles duplicate approval clicks; this is not the normal inbound message dedupe path. Callback capabilities are not persisted in handler data. |
| Discord messages | Discord message id. |
| Discord commands/buttons | Discord interaction id. |
| Telegram messages | Telegram `update_id`. |
| Telegram callback buttons | Telegram callback query id. |
| Webhook | Caller-supplied `eventId`, or the generated run id when omitted. |

## Custom adapters

Custom adapters implement `Adapter` from `@hunvreus/heypi/adapter` and can live in separate packages. Built-in adapters are concrete integrations, not subclassable base classes.

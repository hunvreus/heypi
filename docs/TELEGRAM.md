# Telegram Setup

heypi uses Telegram long polling.

## Create Bot

1. Open Telegram and message `@BotFather`.
2. Run `/newbot`.
3. Pick a name and username.
4. Copy the token:

```bash
TELEGRAM_BOT_TOKEN=...
```

Check:

```bash
pnpm exec heypi telegram check --env examples/telegram-workout/.env
```

## Discover Chat ID

Telegram bots cannot enumerate chats. The bot has to observe a message.

Run:

```bash
pnpm exec heypi telegram observe --env examples/telegram-workout/.env
```

Then send `/start` to the bot DM, or post in the target group. The CLI prints:

```ts
target: { adapter: "telegram", channel: "123456789" }
```

Use that target for explicit cron jobs. Heartbeat jobs can target known chats after the bot has seen them once.

## Inbound Access

Telegram decides which updates heypi receives through bot membership, privacy mode, and long-polling delivery. heypi's `allow` config only filters updates after Telegram delivers them.

```ts
telegram({
  token: process.env.TELEGRAM_BOT_TOKEN!,
  allow: {
    chats: ["-1001234567890"],
    users: ["8734062810"],
    dms: true,
  },
  trigger: "mention",
});
```

Defaults:

- omitted `allow` accepts all delivered updates
- omitted `chats` or `users` accepts all delivered updates for that dimension
- `chats` applies to groups/channels only
- `dms` defaults to `true`; set `dms: false` to drop private chats
- `trigger` defaults to `"mention"` for groups
- `trigger: "message"` makes every allowed group message run the agent
- accepted private chats always run the agent

`allow.users` controls who may talk to the bot. `approval.approvers` controls who may approve tool calls. `jobs.scope` and `jobs.target` only affect scheduled outbound jobs.

## Streaming And Delivery

```ts
telegram({
  token: process.env.TELEGRAM_BOT_TOKEN!,
  streaming: true,
});
```

`streaming` is off by default. Use `true` for sensible defaults, or pass `{ intervalMs, minChars, maxFailures }` to tune draft edits. Telegram progress messages are suppressed while streaming is active to avoid duplicate visible replies.

Telegram delivery calls are serialized by default. Provider rate limits are retried with backoff. Ambiguous timeouts are not retried for non-idempotent sends such as new messages or file uploads. Most apps do not need to configure this. If Telegram needs slower pacing, set `delivery: { intervalMs: 500 }`; use `delivery: false` only for development or custom transport control.

## Groups

For groups:

1. Add the bot to the group.
2. Send `/start` or mention the bot while `telegram observe` is running.
3. Use the printed group chat id.

If privacy mode blocks messages, disable privacy for the bot in BotFather with `/setprivacy`, or only rely on commands/mentions that Telegram delivers.

## Common Failures

`Unauthorized` means the bot token is invalid or revoked.

No updates during `observe` usually means the bot has a webhook configured elsewhere, the message was sent before observe started, or group privacy mode blocked the message.

If using another service with the same bot token, stop it before running long polling.

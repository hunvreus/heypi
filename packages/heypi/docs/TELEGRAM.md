# Telegram

heypi uses Telegram long polling.

For a runnable Telegram app, see [`examples/telegram-workout`](https://github.com/hunvreus/heypi/tree/main/examples/telegram-workout).

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

Telegram bots cannot enumerate chats. The bot has to observe a message. The command uses `TELEGRAM_BOT_TOKEN` from the env file, deletes any active webhook for that bot token, then long-polls Telegram updates until it sees a DM, group, or channel message.

Run:

```bash
pnpm exec heypi telegram observe --env examples/telegram-workout/.env
```

Then send `/start` to the bot DM, or post in the target group. The CLI prints:

```ts
targets: { telegram: { channels: ["123456789"] } }
```

For groups and channels, the printed chat id is the value to use in `allow.chats` and scheduled job `targets.telegram.channels`. For DM-only bots, leave `allow.chats` empty or restrict by user id with `allow.users`.

Use `targets` for explicit cron jobs. Heartbeat jobs can use `scope: { telegram: {} }` after the bot has seen the chat once.

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
  threadTrigger: "message",
});
```

Telegram-specific defaults: `chats` applies to groups/channels only, and forum topic replies use `threadTrigger`.

See [`CHAT.md`](CHAT.md) for shared allow defaults, streaming, busy-thread behavior, approvals, cancel, and delivery.

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

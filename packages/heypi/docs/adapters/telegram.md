# Telegram

The Telegram adapter lets a heypi agent receive Telegram DMs, groups, supergroups, and forum topics through long polling or Telegram webhooks.

heypi's `allow` config filters what the bot responds to; Telegram controls what it receives. Configure bot membership and group privacy mode in Telegram first.

For a runnable example, see [`examples/telegram-workout`](https://github.com/hunvreus/heypi/tree/main/examples/telegram-workout).

## Options

`telegram()` accepts the shared options documented in [Adapters](index.md), plus Telegram-specific options below.

| Option | Required | Description |
| --- | --- | --- |
| `token` | Yes, unless `TELEGRAM_BOT_TOKEN` is set | Telegram bot token from BotFather. |
| `name` | No | Adapter name. Defaults to `telegram`. |
| `apiUrl` | No | Telegram API URL override. Only use for custom Telegram-compatible gateways. |
| `mode` | No | `"polling"` or `"webhook"`. Defaults to `"polling"`. |
| `pollTimeoutSeconds` | No | Long-poll timeout. Defaults to `25`. |
| `webhook.path` | No | HTTP path for Telegram updates. Defaults to `/telegram/<adapter-name>/webhook`. |
| `webhook.unsafePathOverride` | No | Required when overriding `webhook.path`. |
| `webhook.secretToken` | Webhook mode, unless `TELEGRAM_WEBHOOK_SECRET` is set | Telegram webhook secret token checked against `X-Telegram-Bot-Api-Secret-Token`. |
| `webhook.port` | No | HTTP listener port name/number when the app exposes multiple HTTP listeners. |
| `webhook.maxBodyBytes` | No | Maximum webhook request body size. Defaults to `1000000`. |
| `allow.chats` | No | Telegram chat IDs where the bot may respond. Applies to groups, supergroups, and forum topics. |
| `allow.users` | No | Telegram user IDs allowed to talk to the bot. |
| `allow.bots` | No | `true` to accept messages from all other Telegram bots, or a list of Telegram bot user IDs. Defaults to rejecting bot messages. |
| `allow.dms` | No | Whether DMs are accepted. |
| `permissions.approvers` | No | Telegram user IDs allowed to list and resolve approvals for this adapter. Groups are not supported. |
| `permissions.admins` | No | Telegram user IDs allowed to use approval admin actions for this adapter. Admins inherit approver permissions. |
| `trigger` | No | `"mention"` or `"message"` for top-level group messages. Defaults to `"mention"` in groups. |
| `threadTrigger` | No | `"message"`, `"mention"`, or `false` for forum topic replies. Defaults to `"message"` in active topics. |
| `response.placement` | No | `"auto"`, `"same"`, or `"reply"`. Defaults to `"auto"`: private chats and forum topics are flat, group replies are anchored to the triggering message. |
| `response.continueRecentMs` | No | Same-actor follow-up window for root groups. Defaults to `300000`; set `false` to require explicit replies for continuation. |
| `progress` | No | Progress message behavior, or `false`. |
| `streaming` | No | Draft reply streaming behavior. |
| `delivery` | No | Telegram send pacing/retry behavior, or `false`. |

Telegram has no Slack user group or Discord role equivalent in heypi. With:

```ts
allow: { chats: ["CHAT1"], users: ["U1"] }
```

`U1` can use the bot in `CHAT1`. DMs require `allow.dms`.

Bot messages are rejected by default. To accept fixture or integration messages from another Telegram bot, configure `allow.bots`:

```ts
allow: { chats: ["CHAT1"], bots: ["123456789"] }
```

Use `bots: true` to accept messages from all other Telegram bots. This adapter's own Telegram bot messages are always dropped, even when `allow.bots` is `true` or includes its own bot user ID. Allowed bot messages still have to pass the chat, DM, and trigger rules.

`allow.bots` only grants input access. Bot actors cannot list, approve, deny, or revoke approvals through the zero-config fallback. To let a trusted bot resolve approvals, list its bot user ID in `permissions.approvers` or `permissions.admins`.

## Setup

### Manual setup

1. Message `@BotFather` in Telegram.
2. Run `/newbot`.
3. Pick a name and username.
4. Copy the bot token into your environment.
5. Add the bot to the chats where it should respond.

Group privacy mode can limit what the bot receives. Use BotFather's `/setprivacy` when the bot needs all group messages instead of only commands and mentions.

Telegram channel posts are not a primary chat-agent surface and are not handled as inbound prompts. Use groups, supergroups, or forum topics for conversational use.

### CLI-assisted setup

Verify the token and observe delivered updates:

```bash
heypi telegram check --env .env
heypi telegram observe --env .env
```

Telegram cannot enumerate chats. `telegram observe` waits for a delivered DM, group, supergroup, or forum topic message and prints IDs.

`telegram observe` deletes any active webhook for that bot token before polling. Do not run another long-polling process with the same token while observing.

For production webhook mode, expose heypi over HTTPS, then register Telegram's webhook URL:

```bash
heypi telegram set-webhook --env .env --url https://agent.example.com/telegram/telegram/webhook --secret-token "$TELEGRAM_WEBHOOK_SECRET"
```

The URL path defaults to `/telegram/telegram/webhook` for the default adapter name. Named adapters use `/telegram/<name>/webhook`.

To return a token to polling mode:

```bash
heypi telegram delete-webhook --env .env
```

Telegram does not allow `getUpdates` polling while a webhook is active for the same bot token. Use polling for local/dev, and webhook mode for production HTTP ingress.

Webhook mode acknowledges Telegram after validating the secret token and request body, then processes the update asynchronously. If the process exits after the acknowledgement but before processing finishes, Telegram will not redeliver that update.

Telegram message updates are deduped by `update_id`. Callback buttons are deduped by callback query id.

heypi syncs Telegram's bot command menu from its built-in command catalog on adapter startup and when `heypi telegram set-webhook` runs. Manual BotFather command-menu entries for the same bot can be overwritten.

## Config

```ts
createHeypi({
  state: { root: "./state" },
  adapters: [
    telegram({
      mode: "polling",
      allow: {
        chats: ["-1001234567890"],
        users: ["8734062810"],
        bots: ["123456789"],
        dms: true,
      },
      trigger: "mention",
      threadTrigger: "message",
      response: {
        placement: "auto",
        continueRecentMs: 300_000,
      },
    }),
  ],
});
```

Webhook mode registers an HTTP route through heypi's public HTTP listener:

```ts
createHeypi({
  state: { root: "./state" },
  http: { port: Number(process.env.PORT ?? 3000) },
  adapters: [
    telegram({
      mode: "webhook",
      allow: {
        chats: ["-1001234567890"],
        users: ["8734062810"],
      },
    }),
  ],
});
```

Telegram webhook mode needs a stable public URL for Telegram to deliver updates. Use `port: 0` only for local polling/admin setups, not for webhook mode unless a tunnel or reverse proxy provides a stable URL.

Common environment variables:

| Variable | Required when | Description |
| --- | --- | --- |
| `TELEGRAM_BOT_TOKEN` | Always | Bot token from BotFather. |
| `TELEGRAM_WEBHOOK_SECRET` | Webhook mode | Secret token passed to `setWebhook` and checked by heypi. |

For app-wide config such as `state`, `runtime`, and `agent`, see [Configuration](../configuration/index.md).

## CLI

| Command | Purpose |
| --- | --- |
| `heypi telegram check [--env .env]` | Verify Telegram bot credentials. |
| `heypi telegram observe [--env .env] [--timeout 60]` | Wait for a delivered Telegram update and print IDs. |
| `heypi telegram set-webhook [--env .env] --url <url> --secret-token <token>` | Register Telegram webhook delivery and bot commands. |
| `heypi telegram delete-webhook [--env .env]` | Remove Telegram webhook delivery so polling can be used again. |

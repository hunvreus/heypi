# Telegram

The Telegram adapter lets a heypi agent receive Telegram DMs, groups, channels, and forum topics through long polling.

heypi's `allow` config filters what the bot responds to; Telegram controls what it receives. Configure bot membership and group privacy mode in Telegram first.

For a runnable example, see [`examples/telegram-workout`](https://github.com/hunvreus/heypi/tree/main/examples/telegram-workout).

## Options

`telegram()` accepts the shared options documented in [Adapters](index.md), plus Telegram-specific options below.

| Option | Required | Description |
| --- | --- | --- |
| `token` | Yes | Telegram bot token from BotFather. |
| `name` | No | Adapter name. Defaults to `telegram`. |
| `apiUrl` | No | Telegram API URL override. Only use for custom Telegram-compatible gateways. |
| `pollTimeoutSeconds` | No | Long-poll timeout. Defaults to `25`. |
| `allow.chats` | No | Telegram chat IDs where the bot may respond. Applies to groups, channels, and forum topics. |
| `allow.users` | No | Telegram user IDs allowed to talk to the bot. |
| `allow.dms` | No | Whether DMs are accepted. |
| `trigger` | No | `"mention"` or `"message"` for top-level group/channel messages. Defaults to `"mention"` in groups and channels. |
| `threadTrigger` | No | `"message"`, `"mention"`, or `false` for forum topic replies. Defaults to `"message"` in active topics. |
| `progress` | No | Progress message behavior, or `false`. |
| `streaming` | No | Draft reply streaming behavior. |
| `delivery` | No | Telegram send pacing/retry behavior, or `false`. |

Telegram has no Slack user group or Discord role equivalent in heypi. With:

```ts
allow: { chats: ["CHAT1"], users: ["U1"] }
```

`U1` can use the bot in `CHAT1`. DMs require `allow.dms`.

## Setup

### Manual setup

1. Message `@BotFather` in Telegram.
2. Run `/newbot`.
3. Pick a name and username.
4. Copy the bot token into your environment.
5. Add the bot to the chats where it should respond.

Group privacy mode can limit what the bot receives. Use BotFather's `/setprivacy` when the bot needs all group messages instead of only commands and mentions.

### CLI-assisted setup

Verify the token and observe delivered updates:

```bash
npx @hunvreus/heypi telegram check --env .env
npx @hunvreus/heypi telegram observe --env .env
```

Telegram cannot enumerate chats. `telegram observe` waits for a delivered DM, group, channel, or forum message and prints IDs for config and job targets.

`telegram observe` deletes any active webhook for that bot token before polling. Do not run another long-polling process with the same token while observing.

## Config

```ts
createHeypi({
	state: { root: "./state" },
	adapters: [
		telegram({
			token: process.env.TELEGRAM_BOT_TOKEN!,
			allow: {
				chats: ["-1001234567890"],
				users: ["8734062810"],
				dms: true,
			},
			trigger: "mention",
			threadTrigger: "message",
		}),
	],
});
```

Common environment variables:

| Variable | Required when | Description |
| --- | --- | --- |
| `TELEGRAM_BOT_TOKEN` | Always | Bot token from BotFather. |

For app-wide config such as `state`, `runtime`, and `agent`, see [Configuration](../configuration/index.md).

## CLI

| Command | Purpose |
| --- | --- |
| `npx @hunvreus/heypi telegram check [--env .env]` | Verify Telegram bot credentials. |
| `npx @hunvreus/heypi telegram observe [--env .env] [--timeout 60]` | Wait for a delivered Telegram update and print IDs/target snippets. |

# Discord Setup

heypi supports Discord through the gateway using `discord.js`.

## Create Bot

1. Open <https://discord.com/developers/applications>.
2. Create an application.
3. Add a bot under **Bot**.
4. Enable **Message Content Intent**.
5. Copy the bot token:

```bash
DISCORD_BOT_TOKEN=...
```

Check:

```bash
pnpm exec heypi discord check --env .env
```

For a runnable app, see [`../examples/discord-project`](../examples/discord-project). It includes streaming, core tools, and an approval-gated status update tool.

Generate an invite URL:

```bash
pnpm exec heypi discord invite --client-id <application-id>
```

The check command also prints an invite URL using the bot identity.

## Configure Adapter

```ts
discord({
  token: process.env.DISCORD_BOT_TOKEN!,
  allow: {
    guilds: ["123456789012345678"],
    channels: ["234567890123456789"],
    users: ["345678901234567890"],
    dms: true,
  },
  trigger: "mention",
  threadTrigger: "message",
});
```

Required gateway intents:

- Guilds
- Guild Messages
- Direct Messages
- Message Content

## Discover IDs

List visible text channels:

```bash
pnpm exec heypi discord channels --env .env
```

Observe a delivered message:

```bash
pnpm exec heypi discord observe --env .env
```

Then send a DM or post in a channel the bot can read. The CLI prints guild, channel, and user IDs:

```text
guild: 123456789012345678 (Example Server)
channel: 234567890123456789 (ops)
user: 345678901234567890 (alice)
target: { adapter: "discord", channel: "234567890123456789" }
```

Use the user ID in `approval.approvers`:

```bash
HEYPI_APPROVERS=345678901234567890
```

An empty or omitted `approval.approvers` list means any user in the chat scope can approve tool calls.

## Inbound Access

Discord decides which events heypi receives through bot invite, gateway intents, channel permissions, and DM availability. heypi's `allow` config only filters events after Discord delivers them.

Discord-specific defaults: `channels` applies to non-DM channels only, and Discord thread channels use `threadTrigger`.

See [`CHAT.md`](CHAT.md) for shared allow defaults, streaming, busy-thread behavior, approvals, cancel, and delivery.

## Conversation Model

Discord thread channels are modeled as their own conversation because Discord gives them their own channel ID. Normal channels and DMs use the channel or DM ID as the conversation key. Discord server ID is stored as the provider `team` value.

## Common Failures

`Used disallowed intents` usually means Message Content Intent is not enabled in the Discord Developer Portal.

No messages in channels usually means the bot lacks channel permissions, Message Content Intent is disabled, or the message did not mention the bot while `trigger` is `"mention"`.

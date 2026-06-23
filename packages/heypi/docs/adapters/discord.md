# Discord

The Discord adapter lets a heypi agent receive Discord messages, stream replies, upload generated files, and render approval buttons.

Discord decides what the bot receives before heypi sees a message. Configure the bot invite, gateway intents, server permissions, channel permissions, and DM availability first; then use heypi's `allow` config to filter delivered events.

For a runnable example, see [`examples/discord-gondolin`](https://github.com/hunvreus/heypi/tree/main/examples/discord-gondolin).

## Options

`discord()` accepts the shared options documented in [Adapters](index.md), plus Discord-specific options below.

| Option | Required | Description |
| --- | --- | --- |
| `token` | Yes, unless `DISCORD_BOT_TOKEN` is set | Discord bot token. |
| `clientId` | Native commands, unless `DISCORD_CLIENT_ID` is set | Discord application client ID. When set, heypi registers global application commands at startup. |
| `registerCommands` | No | Whether to register native commands when `clientId` is set. Defaults to `true`. |
| `name` | No | Adapter name. Defaults to `discord`. |
| `allow.channels` | No | Discord channel IDs where the bot may respond. Thread channels use their own channel ID. |
| `allow.users` | No | Discord user IDs allowed to talk to the bot. |
| `allow.groups` | No | Discord role IDs allowed to talk to the bot. |
| `allow.bots` | No | `true` to accept messages from all other Discord bots, or a list of Discord bot user IDs. Defaults to rejecting bot messages. |
| `allow.dms` | No | Whether DMs are accepted. |
| `permissions.approvers` | No | Discord user IDs or role IDs allowed to list and resolve approvals for this adapter. |
| `permissions.admins` | No | Discord user IDs or role IDs allowed to use approval admin actions for this adapter. Admins inherit approver permissions. |
| `trigger` | No | `"mention"` or `"message"` for top-level channel messages. Defaults to `"mention"` in channels. |
| `threadTrigger` | No | `"message"`, `"mention"`, or `false` for thread replies. Defaults to `"message"` in active threads. |
| `response.placement` | No | `"auto"`, `"same"`, or `"reply"`. Defaults to `"auto"`: DMs and Discord threads are flat, root channel replies are anchored to the triggering message. |
| `response.continueRecentMs` | No | Same-actor follow-up window for root channels. Defaults to `300000`; set `false` to require explicit replies for continuation. |
| `progress` | No | Progress message behavior, or `false`. |
| `streaming` | No | Draft reply streaming behavior. |
| `delivery` | No | Discord send pacing/retry behavior, or `false`. |

Actor access is `users OR groups`. Channel access is separate. With:

```ts
allow: { channels: ["C1"], users: ["U1"], groups: ["R1"] }
```

`U1` or members of role `R1` can use the bot in `C1`. DMs require `allow.dms` and do not carry server role context.

Bot messages are rejected by default. To accept fixture or integration messages from another Discord bot, configure `allow.bots`:

```ts
allow: { channels: ["C1"], bots: ["B1"] }
```

Use `bots: true` to accept messages from all other Discord bots. This adapter's own Discord bot messages are always dropped, even when `allow.bots` is `true` or includes its own bot user ID. Allowed bot messages still have to pass the channel, DM, and trigger rules.

`allow.bots` only grants input access. Bot actors cannot list, approve, deny, or revoke approvals through the zero-config fallback. To let a trusted bot resolve approvals, list its bot user ID in `permissions.approvers` or `permissions.admins`.

## Setup

### Manual setup

1. Create an application at <https://discord.com/developers/applications>.
2. Add a bot.
3. Enable **Message Content Intent**.
4. Invite the bot to the server with message permissions.
5. Copy the bot token into your environment.

Required gateway intents:

```text
Guilds
Guild Messages
Direct Messages
Message Content
```

Required OAuth scopes: `bot` and `applications.commands`.

Required bot permissions: `View Channel`, `Send Messages`, `Send Messages in Threads`, `Read Message History`, `Add Reactions`, and `Attach Files`.

Native controls use flat application commands:

```text
/approvals
/bypasses
/approve approval-id
/deny approval-id
/status run-or-call-id
/cancel turn-id-or-trace
/revoke bypass-id
/bash command
```

Discord interaction tokens are short-lived callback credentials. heypi uses Discord interaction ids for dedupe and routing metadata, not interaction tokens.

### CLI-assisted setup

Generate an invite URL and verify the token:

```bash
heypi discord invite --client-id <application-id>
heypi discord check --env .env
```

`discord invite` prints an OAuth install URL with the `bot` and `applications.commands` scopes plus heypi's required bot permissions. Discord application IDs are snowflakes; keep them as strings in config, environment variables, and CLI usage.

Use `heypi discord channels [query]` to list visible channel IDs. Use `heypi discord observe` to capture exact guild, channel, and user IDs from a delivered message.

## Config

```ts
createHeypi({
  state: { root: "./state" },
  adapters: [
    discord({
      allow: {
        channels: ["234567890123456789"],
        users: ["345678901234567890"],
        groups: ["456789012345678901"],
        bots: ["567890123456789012"],
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

Common environment variables:

| Variable | Required when | Description |
| --- | --- | --- |
| `DISCORD_BOT_TOKEN` | Always | Bot token from the Discord developer portal. |
| `DISCORD_CLIENT_ID` | `discord invite` without `--client-id` | Application client ID used by `discord invite` when `--client-id` is omitted. |

For app-wide config such as `state`, `runtime`, and `agent`, see [Configuration](../configuration/index.md).

## CLI

| Command | Purpose |
| --- | --- |
| `heypi discord check [--env .env]` | Verify Discord bot credentials. |
| `heypi discord invite --client-id <application-id>` | Print a Discord install URL. |
| `heypi discord channels [query] [--env .env]` | List or filter Discord text channels visible to the bot. |
| `heypi discord observe [--env .env] [--timeout 60]` | Wait for a delivered Discord message and print IDs. |
| `heypi discord env` | Print expected Discord environment variable names. |

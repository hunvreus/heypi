# Slack Setup

heypi supports Slack Socket Mode and Node HTTP mode.

For a runnable Slack app, see [`examples/slack-devops`](https://github.com/hunvreus/heypi/tree/main/examples/slack-devops).

That example enables the local admin panel by default and prints a one-time login link at startup.

## Create App

1. Open <https://api.slack.com/apps>.
2. Create a new app from scratch.
3. Choose the target workspace.

## Bot Token Scopes

Add these bot scopes under **OAuth & Permissions**:

```text
app_mentions:read
channels:history
channels:read
chat:write
chat:write.public
files:read
files:write
im:history
reactions:write
```

Install the app to the workspace and copy the bot token:

```bash
SLACK_BOT_TOKEN=<slack-bot-token>
```

## Signing Secret

HTTP mode requires Slack's signing secret so heypi can verify incoming Slack requests. Socket Mode receives events over the websocket authenticated by `SLACK_APP_TOKEN`, so a signing secret is not required for Socket Mode.

For HTTP mode, copy the signing secret under **Basic Information**:

```bash
SLACK_SIGNING_SECRET=...
```

## Local Development: Socket Mode

1. Enable **Socket Mode**.
2. Create an app-level token with `connections:write`.
3. Set:

```bash
SLACK_APP_TOKEN=<slack-app-token>
```

Use:

```ts
slack({
  botToken: process.env.SLACK_BOT_TOKEN!,
  mode: "socket",
  appToken: process.env.SLACK_APP_TOKEN!,
  allow: { channels: ["C123"] },
  trigger: "mention",
});
```

Check:

```bash
pnpm exec heypi slack check --env examples/slack-devops/.env
```

The CLI loads `./.env` by default when it exists; pass `--env` when you keep the example env elsewhere. `slack check` validates the bot token with Slack and prints the workspace/team and bot identity.

List Slack channel IDs visible to the bot:

```bash
pnpm exec heypi slack channels --env examples/slack-devops/.env
```

For private channels, invite the bot to the channel, add the Slack `groups:read` bot scope, reinstall the app, then run:

```bash
pnpm exec heypi slack channels --env examples/slack-devops/.env --private
```

When running the Slack example locally, open the one-time admin login link printed at startup. If it expires while the example is still running, mint a fresh link with `pnpm heypi admin link --state examples/slack-devops/state`.

When `HEYPI_SLACK_JOB_CHANNEL` is set, the Slack example configures two app-level jobs:

- `daily-health-check`: active cron job at 09:00 UTC, delivered to `HEYPI_SLACK_JOB_CHANNEL`.
- `idle-incident-follow-up`: paused heartbeat job for quiet incident threads in `HEYPI_SLACK_JOB_CHANNEL`.

If it is unset, the example logs a warning, starts normally, and skips those jobs. Cron jobs are executed by heypi's in-process scheduler. No external system cron is required. Cron jobs require explicit `targets`; heartbeat jobs require either explicit `targets` or adapter-keyed `scope`.

Set the job channel in `examples/slack-devops/.env`:

```bash
HEYPI_SLACK_JOB_CHANNEL=C1234567890
```

## Production: HTTP Mode

Configure Event Subscriptions and Interactivity with the same public URL:

```text
https://<host>/slack/acme/events
```

Use:

```ts
createHeypi({
  state: { root: "./state" },
  http: { port: Number(process.env.PORT ?? 3000) },
  adapters: [
    slack({
      name: "acme",
      botToken: process.env.SLACK_BOT_TOKEN!,
      signingSecret: process.env.SLACK_SIGNING_SECRET!,
      mode: "http",
      allow: { channels: ["C123"] },
      trigger: "mention",
    }),
  ],
});
```

HTTP mode registers Bolt's receiver on heypi's shared Node HTTP listener. It is for normal hosted Node services. The default route is `/slack/{name}/events`; if you omit `name`, it is `/slack/slack/events`.

If you run multiple Slack HTTP adapters in one app, give each adapter a unique `name`. A custom `path` is an escape hatch and must be paired with `unsafePathOverride: true`; it cannot use `/admin` or collide with another route.

Generate a starter manifest:

```bash
pnpm exec heypi slack manifest --url https://<host>/slack/acme/events
```

## Events

Subscribe to these bot events:

```text
app_mention
message.channels
message.im
```

For private channels, invite the bot to the channel and grant the private-channel scopes required by your Slack app configuration.

## Inbound Access

Slack decides which events heypi receives through app installation, OAuth scopes, event subscriptions, and channel membership. heypi's `allow` config only filters events after Slack delivers them. For channel messages, the Slack app must still be subscribed to the right events and invited to the channel; `allow.channels` does not make Slack send events.

```ts
slack({
  // ...tokens and mode
  allow: {
    teams: ["T123"],
    channels: ["C123"],
    users: ["U123"],
    dms: true,
  },
  trigger: "mention",
  threadTrigger: "message",
});
```

Slack-specific defaults: `channels` applies to non-DM channels only. Private Slack replies, including unauthorized approval/status replies, are posted back into the current thread when Slack provides a thread timestamp.

See [`CHAT.md`](CHAT.md) for shared allow defaults, streaming, busy-thread behavior, approvals, cancel, and delivery.

## Common Failures

`invalid_auth` means `SLACK_BOT_TOKEN` is wrong or the app was reinstalled.

`not_authed` usually means the token was not sent or was loaded from the wrong `.env` file.

No messages in channels usually means missing `app_mentions:read`, missing `message.channels`, or the app was not invited to the channel.

Buttons not working usually means Interactivity is disabled or points to the wrong URL.

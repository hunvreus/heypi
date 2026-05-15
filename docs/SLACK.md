# Slack Setup

heypi supports Slack Socket Mode and Node HTTP mode.

## Create App

1. Open <https://api.slack.com/apps>.
2. Create a new app from scratch.
3. Choose the target workspace.

## Bot Token Scopes

Add these bot scopes under **OAuth & Permissions**:

```text
app_mentions:read
channels:history
chat:write
chat:write.public
files:read
files:write
im:history
reactions:write
```

Install the app to the workspace and copy the bot token:

```bash
SLACK_BOT_TOKEN=xoxb-...
```

## Signing Secret

Under **Basic Information**, copy the signing secret:

```bash
SLACK_SIGNING_SECRET=...
```

## Local Development: Socket Mode

1. Enable **Socket Mode**.
2. Create an app-level token with `connections:write`.
3. Set:

```bash
SLACK_APP_TOKEN=xapp-...
```

Use:

```ts
slack({
  botToken: process.env.SLACK_BOT_TOKEN!,
  signingSecret: process.env.SLACK_SIGNING_SECRET!,
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

## Production: HTTP Mode

Configure Event Subscriptions and Interactivity with the same public URL:

```text
https://<host>/slack/events
```

Use:

```ts
slack({
  botToken: process.env.SLACK_BOT_TOKEN!,
  signingSecret: process.env.SLACK_SIGNING_SECRET!,
  mode: "http",
  port: Number(process.env.PORT ?? 3000),
  path: "/slack/events",
  allow: { channels: ["C123"] },
  trigger: "mention",
});
```

HTTP mode starts Bolt's Node HTTP receiver inside the heypi process. It is for normal hosted Node services.

Generate a starter manifest:

```bash
pnpm exec heypi slack manifest --url https://<host>/slack/events
```

## Events

Subscribe to these bot events:

```text
app_mention
message.channels
message.im
```

For private channels, invite the bot to the channel and add private-channel scopes later if needed.

## Serverless Status

Cloudflare Workers and other Fetch API runtimes are not supported yet. Use Socket Mode for local development and HTTP mode for hosted Node services. Serverless support is planned, but it needs a complete Slack receiver, scheduler, storage, attachment, and deployment story before it should be used.

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
});
```

Defaults:

- omitted `allow` accepts all delivered events
- omitted `teams`, `channels`, or `users` accepts all delivered events for that dimension
- `channels` applies to non-DM channels only
- `dms` defaults to `true`; set `dms: false` to drop DMs
- `trigger` defaults to `"mention"` for channels
- `trigger: "message"` makes every allowed channel message run the agent
- accepted DMs always run the agent

`allow.users` controls who may talk to the bot. `approval.approvers` controls who may approve tool calls. `jobs.scope` and `jobs.target` only affect scheduled outbound jobs.

## Streaming And Delivery

```ts
slack({
  // ...tokens and mode
  streaming: true,
});
```

`streaming` is off by default. Use `true` for sensible defaults, or pass `{ intervalMs, minChars, maxFailures }` to tune draft edits. If Slack progress messages are configured, the visible progress message is suppressed while streaming is active; reactions can still be used.

Slack delivery calls are serialized by default. Provider rate limits are retried with backoff. Ambiguous timeouts are not retried for non-idempotent sends such as new messages or file uploads. Most apps do not need to configure this. If Slack needs slower pacing, set `delivery: { intervalMs: 500 }`; use `delivery: false` only for development or custom transport control.

## Common Failures

`invalid_auth` means `SLACK_BOT_TOKEN` is wrong or the app was reinstalled.

`not_authed` usually means the token was not sent or was loaded from the wrong `.env` file.

No messages in channels usually means missing `app_mentions:read`, missing `message.channels`, or the app was not invited to the channel.

Buttons not working usually means Interactivity is disabled or points to the wrong URL.

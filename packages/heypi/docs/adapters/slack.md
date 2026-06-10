# Slack

The Slack adapter lets a heypi agent receive Slack messages, stream replies, upload generated files, and render approval buttons.

Slack decides what your app receives before heypi sees an event. Configure Slack scopes, event subscriptions, interactivity, and channel membership first; then use heypi's `allow` config to filter delivered events.

For a runnable example, see [`examples/slack-devops`](https://github.com/hunvreus/heypi/tree/main/examples/slack-devops).

## Modes

| Mode | Use when | Slack setup | heypi config |
| --- | --- | --- | --- |
| Socket | Local development, private deployments, or no public request URL. | Enable Socket mode and create an app-level token with `connections:write`. | `mode: "socket"` and `appToken`. |
| HTTP | Hosted services with a public HTTPS URL. | Set Event Subscriptions and Interactivity URLs to your heypi Slack route. | `mode: "http"`, `signingSecret`, and top-level [`http`](../configuration/http.md). |

The default HTTP route is `/slack/{name}/events`. With the default adapter name, use this URL; the repeated `slack` segment is expected because the adapter name also defaults to `slack`:

```text
https://<host>/slack/slack/events
```

With `slack({ name: "ops", mode: "http", ... })`, use:

```text
https://<host>/slack/ops/events
```

## Options

`slack()` accepts the shared options documented in [Adapters](index.md), plus Slack-specific options below.

| Option | Required | Description |
| --- | --- | --- |
| `mode` | No | `"socket"` or `"http"`. Defaults to `"socket"`. |
| `botToken` | Yes | Slack bot token, usually `xoxb-...`. |
| `appToken` | Socket mode | Slack app-level token, usually `xapp-...`. |
| `signingSecret` | HTTP mode | Slack signing secret for HTTP request verification. |
| `name` | No | Adapter name. Also controls the default HTTP route. Defaults to `slack`. |
| `port` | HTTP mode | Route port constraint or standalone receiver port when not using top-level `http`. |
| `path` | HTTP mode | Custom HTTP route path. Requires `unsafePathOverride: true`. |
| `unsafePathOverride` | Custom HTTP path | Required guard for overriding the default HTTP path. |
| `allow.channels` | No | Channel IDs where the bot may respond. Applies to non-DM channels. |
| `allow.users` | No | Slack user IDs allowed to talk to the bot. |
| `allow.groups` | No | Slack user group IDs allowed to talk to the bot. Requires `usergroups:read`. |
| `allow.bots` | No | `true` to accept messages from all other Slack bots/apps, or a list of Slack bot IDs, app IDs, or bot user IDs. Defaults to rejecting bot messages. |
| `allow.dms` | No | Whether DMs are accepted. |
| `permissions.approvers` | No | Slack user IDs or user group IDs allowed to list and resolve approvals for this adapter. |
| `permissions.admins` | No | Slack user IDs or user group IDs allowed to use approval admin actions for this adapter. Admins inherit approver permissions. |
| `trigger` | No | `"mention"` or `"message"` for top-level channel messages. Defaults to `"mention"` in channels. |
| `threadTrigger` | No | `"message"`, `"mention"`, or `false` for thread replies. Defaults to `"message"` in active threads. |
| `reply` | No | `"thread"`, `"same"`, or `"channel"`. Controls where normal replies go. |
| `replyBroadcast` | No | Broadcast thread replies back to the channel. |
| `progress` | No | Progress reaction/message behavior, or `false`. |
| `streaming` | No | Draft reply streaming behavior. |
| `delivery` | No | Slack send pacing/retry behavior, or `false`. |

Actor access is `users OR groups`. Channel access is separate. With:

```ts
allow: { channels: ["C1"], users: ["U1"], groups: ["S1"] }
```

`U1` or members of `S1` can use the bot in `C1`. DMs require `allow.dms`.

Bot messages are rejected by default. To accept fixture or integration messages from another Slack app, configure `allow.bots`:

```ts
allow: { channels: ["C1"], bots: ["B_TEST"] }
```

Use `bots: true` to accept messages from all other Slack bots/apps. This adapter's own Slack bot/app messages are always dropped, even when `allow.bots` is `true` or includes its own IDs. Allowed bot messages still have to pass the channel, DM, and trigger rules.

`allow.bots` only grants input access. Bot actors cannot list, approve, deny, or revoke approvals through the zero-config fallback. To let a trusted bot resolve approvals, list its bot user ID in `permissions.approvers` or `permissions.admins`.

## Setup

### Manifest setup

Generate a starter Slack manifest for HTTP mode:

```bash
heypi slack manifest --mode http --url https://<host>/slack/slack/events
```

For Socket Mode, generate the Socket Mode manifest:

```bash
heypi slack manifest --mode socket
```

Import the manifest into Slack, then review scopes, events, and interactivity for your workspace. Socket Mode still needs an app-level token with `connections:write`.

### Manual setup

1. Create a Slack app at <https://api.slack.com/apps>.
2. Add a bot user.
3. Add bot scopes from the table below.
4. Subscribe to bot events from the table below.
5. Enable Interactivity for approval buttons and set the HTTP URL when using HTTP mode.
6. Install the app into your workspace.
7. Invite the bot to channels where it should respond.
8. Copy the required tokens or secrets into your environment.

Typical bot scopes:

| Scope | Why it is used |
| --- | --- |
| `app_mentions:read` | Receive channel mentions. |
| `channels:history` | Receive public channel messages. |
| `channels:read` | Resolve public channel metadata. |
| `chat:write` | Send replies. |
| `chat:write.public` | Send to public channels when needed. |
| `files:read` | Read inbound Slack files. |
| `files:write` | Upload generated files. |
| `im:history` | Receive DMs. |
| `reactions:write` | Add progress reactions. |
| `usergroups:read` | Resolve `allow.groups`, `permissions.approvers.groups`, and `permissions.admins.groups`. Only needed when using Slack user groups. |

Add private-channel scopes only if the bot must read private channels.

Typical bot events:

| Event | Why it is used |
| --- | --- |
| `app_mention` | Let users trigger the bot by mentioning it in channels. |
| `message.channels` | Let the bot receive public-channel messages and thread replies. |
| `message.im` | Let the bot receive DMs. |

## Config

### Socket mode

```ts
createHeypi({
	state: { root: "./state" },
	adapters: [
		slack({
			mode: "socket",
			botToken: process.env.SLACK_BOT_TOKEN!,
			appToken: process.env.SLACK_APP_TOKEN!,
			allow: { channels: ["C123"], bots: ["B_TEST"], dms: true },
			trigger: "mention",
			threadTrigger: "message",
		}),
	],
});
```

### HTTP mode

```ts
createHeypi({
	state: { root: "./state" },
	http: { port: Number(process.env.PORT ?? 3000) },
	adapters: [
		slack({
			mode: "http",
			botToken: process.env.SLACK_BOT_TOKEN!,
			signingSecret: process.env.SLACK_SIGNING_SECRET!,
			allow: { channels: ["C123"], dms: true },
			trigger: "mention",
			threadTrigger: "message",
		}),
	],
});
```

Common environment variables:

| Variable | Required when | Description |
| --- | --- | --- |
| `SLACK_BOT_TOKEN` | Both modes | Bot token from OAuth installation. |
| `SLACK_APP_TOKEN` | Socket mode | App-level token with `connections:write`. |
| `SLACK_SIGNING_SECRET` | HTTP mode | Secret used to verify Slack HTTP requests. |

For app-wide config such as `http`, `state`, `runtime`, and `agent`, see [Configuration](../configuration/index.md).

## CLI

| Command | Purpose |
| --- | --- |
| `heypi slack check [--env .env] [--mode socket\|http]` | Verify Slack auth and report the selected transport secrets. |
| `heypi slack manifest --mode socket` | Print a starter Socket Mode Slack manifest. |
| `heypi slack manifest --mode http --url https://host/slack/slack/events` | Print a starter HTTP-mode Slack manifest. |
| `heypi slack channels [--env .env] [--private]` | List channels visible to the bot and print target snippets. |
| `heypi slack env` | Print expected Slack environment variable names. |

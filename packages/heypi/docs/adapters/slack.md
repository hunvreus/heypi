# Slack

The Slack adapter uses Bolt Socket Mode. It responds to direct messages and app mentions, then keeps
public work inside the originating Slack thread.

```ts
import { slack } from "@hunvreus/heypi";

const chat = slack({
	id: "company-slack",
	token: process.env.SLACK_BOT_TOKEN!,
	appToken: process.env.SLACK_APP_TOKEN!,
	allow: { channels: ["C0123456789"] },
	busy: "steer",
});
```

`token` is the bot token and `appToken` is a Socket Mode app token.

## Set up the app

Generate a current Slack manifest and environment template instead of copying scopes manually:

```sh
heypi slack manifest
heypi slack env-example
heypi slack check
```

Use `heypi slack channels` and `heypi slack users` to discover IDs for allowlists and approvers.

## Conversations

An app mention outside a thread creates a new conversation rooted at that message. Replies in the
thread continue its Pi session. Direct messages use one persistent session and are sent as flat DM
messages.

Slack ignores ordinary non-thread channel messages that do not mention the app. A thread reply may
continue an existing agent conversation without repeating the mention.

## Native activity

Slack adds an `eyes` reaction to accepted app mentions and uses
`assistant.threads.setStatus` for `Thinking...` and `Working...` activity.

```ts
slack({ token, appToken, reaction: "eyes", status: true });
```

Set `reaction: false` or `status: false` to disable either surface. The app needs the scopes emitted
by `heypi slack manifest`.

## Approvals and files

Approvals render as messages or cards with Approve and Reject buttons. Configure allowed responders
with Slack user IDs. Incoming Slack files are downloaded with the bot token and checked against the
attachment policy; `chat_attach` uploads generated files back to Slack.

See [Attachments](../configuration/attachments.md) and [Approvals](../configuration/approvals.md).

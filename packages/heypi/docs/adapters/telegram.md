# Telegram

The Telegram adapter uses Bot API long polling. It responds to every private-chat message, mentions
in groups, and replies that continue an existing agent conversation.

```ts
import { telegram } from "@hunvreus/heypi";

const chat = telegram({
	id: "company-telegram",
	token: process.env.TELEGRAM_BOT_TOKEN!,
	botUsername: "heypi_bot",
	allow: { channels: ["-1001234567890"] },
	typing: true,
});
```

The adapter resolves its own identity with `getMe`; `botUsername` supplies an explicit fallback.

## Set up the bot

```sh
heypi telegram env-example
heypi telegram check
heypi telegram webhook-info
heypi telegram listen --timeout 20 --force
```

Long polling cannot consume updates while a webhook is configured. `telegram listen` can consume
updates intended for a running adapter, so it requires `--force`.

## Conversations

Private chats use one persistent Pi session. A top-level group mention starts a new session. Replies
to the bot's message continue that session as a reply chain. Telegram forum topics remain delivery
containers and preserve `message_thread_id`; a new top-level mention in a topic starts a new session.

## Reliability and files

`pollMs` controls the polling delay. `timeoutMs` bounds Bot API calls. `retry` controls bounded
request retries and may be set to `false`. Telegram rate-limit retry metadata is honored.

The adapter refreshes native typing unless `typing: false`. Approval requests use inline buttons.
Inbound files are resolved through the Bot API, validated, and downloaded under the attachment
policy; generated files are sent using the appropriate Telegram upload method.

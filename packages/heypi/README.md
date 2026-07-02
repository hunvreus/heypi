# heypi

Pi-native chat adapters for team agents.

heypi is a thin product shell around Pi. Pi owns the model loop, session state, compaction, retries,
tools, extensions, and transcript. heypi owns agent folder loading, resource staging, chat adapters,
approval UI, and small adapter coordination.

## Usage

```ts
import { approval, createHeypi, loadAgent, local } from "@hunvreus/heypi";

const adapter = local();
const agent = loadAgent("./agent", {
	model,
	adapters: [adapter],
	approvals: {
		layout: "message",
		policy: approval.default(),
	},
});

const app = await createHeypi({ agent });
await app.start();
```

Agent resources are file-based:

```text
agent/
  config.json
  instructions.md
  system.md
  skills/
  tools/
  extensions/
```

`config.json` can define data-only defaults such as `id`, `context`, `approvals`, `state`, `tools`,
`excludeTools`, and `noTools`. Options passed to `loadAgent()` override the file. Function values
such as models, adapters, and approval predicates belong in code, not JSON.

```json
{
  "id": "codex",
  "context": {
    "mode": "current",
    "maxMessages": 20,
    "maxChars": 12000
  },
  "approvals": {
    "layout": "message",
    "showId": false
  }
}
```

The agent folder is copied into a clean Pi-visible bundle under `.heypi`. Pi loads staged resources
from that bundle; heypi does not expose host source paths to the model.

## History

heypi does not paste broad adapter history into every model turn. By default, the Pi session receives
only the current triggered message. Set `context.mode` to `"delta"` to include messages since the
last completed trigger in the same conversation.

Older chat is available through the `chat_history` Pi tool. The model can call it when history is
actually needed instead of carrying old Slack/Discord/Telegram context in every request.

## Adapters

Local is for tests and embedding:

```ts
const adapter = local();
```

Webhook accepts JSON over HTTP:

```ts
const adapter = webhook({ port: 4321, path: "/webhook" });
```

Slack uses Socket Mode:

```ts
const adapter = slack({
	token: process.env.SLACK_BOT_TOKEN!,
	appToken: process.env.SLACK_APP_TOKEN!,
});
```

Discord listens for DMs and bot mentions:

```ts
const adapter = discord({
	token: process.env.DISCORD_TOKEN!,
	clientId: process.env.DISCORD_CLIENT_ID,
});
```

Telegram uses long polling:

```ts
const adapter = telegram({
	token: process.env.TELEGRAM_BOT_TOKEN!,
	botUsername: "heypi_bot",
});
```

All adapters normalize inbound events into the same `ChatMessage` shape and send replies back to the
originating conversation.

## Approvals

Approvals run at the Pi tool-call boundary. heypi renders the approval UI through the active adapter,
then the Pi tool call either continues, is rejected by a person, or is blocked by policy.

Policies are programmable:

```ts
import { approval } from "@hunvreus/heypi";

const agent = loadAgent("./agent", {
	approvals: {
		policy: approval.when(
			({ toolName, actor }) => toolName === "bash" && actor?.id !== "admin",
			"Run bash command.",
		),
	},
});
```

Built-in helpers:

- `approval.never()` allows every call.
- `approval.always(reason)` asks every time.
- `approval.once(reason)` asks once per tool in a session.
- `approval.when(predicate, reason)` asks only when the predicate matches.
- `approval.command(config)` classifies bash commands with `allow`, `approve`, and `block` regexes.
- `approval.default()` uses command classification for `bash` and requires approval for `edit` and
  `write`.

## Current scope

Included:

- `loadAgent("./agent", options)`
- clean staging for `instructions.md`, `system.md`, `skills/`, `tools/`, and `extensions/`
- Pi session creation through `@earendil-works/pi-coding-agent`
- local adapter for tests and embedding
- webhook adapter for simple HTTP ingress
- Slack Socket Mode adapter shell with replies, reactions, and approval buttons
- Discord adapter shell with mention/DM normalization, replies, and approval buttons
- Telegram adapter shell with polling, mention/DM normalization, replies, and approval buttons
- approval message rendering and Pi tool-call approval extension
- programmable approval policies with command classification
- `chat_history` and `chat_reply` Pi tools for explicit older-context lookup and sparse progress updates

Not included yet:

- Card-style approval attachments beyond Slack/Discord/Telegram native buttons
- memory, todo/planning, admin, and runtime providers

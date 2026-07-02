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
		enabled: true,
		layout: "message",
		policy: approval.default(),
	},
});

const app = await createHeypi({ agent });
await app.start();
```

`createHeypi()` accepts an optional `piHost` factory for tests and future runtime providers. The
factory must return the Pi host contract; heypi still sends chat deltas to Pi instead of running its
own model loop.

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

During staging, `system.md` is written as Pi's native `SYSTEM.md`, and `instructions.md` is written
as `APPEND_SYSTEM.md`. `skills/` and `extensions/` stay as Pi-discovered resource folders.

`config.json` can define data-only defaults such as `id`, `context`, `approvals`, `state`, `tools`,
`excludeTools`, `noTools`, and `runtime`. Options passed to `loadAgent()` override the file.
Function values such as models, adapters, and approval predicates belong in code, not JSON.

```json
{
  "id": "codex",
  "allow": {
    "adapters": ["slack"],
    "conversations": ["C0123456789"],
    "users": ["U0123456789"]
  },
  "context": {
    "mode": "current",
    "maxMessages": 20,
    "maxChars": 12000
  },
  "approvals": {
    "enabled": true,
    "layout": "message",
    "showId": false
  },
  "runtime": {
    "kind": "local"
  },
  "admin": {
    "enabled": true,
    "port": 4321
  },
  "todo": {
    "enabled": true
  },
  "memory": {
    "enabled": true
  }
}
```

The agent folder is copied into a clean Pi-visible bundle under `.heypi`. Pi loads staged resources
from that bundle; heypi does not expose host source paths to the model. Staging excludes `.git`,
`.heypi`, and `node_modules`.

`skills/` and `extensions/` use Pi's native resource discovery. `tools/` is kept as an ergonomic
alias for authored extension files that register tools.

## Runtime

The first runtime is local Pi execution:

```json
{
  "runtime": {
    "kind": "local",
    "workspaceDir": "./workspace"
  }
}
```

If `workspaceDir` is omitted, heypi creates a clean staged workspace under `.heypi`. Future Docker or
Gondolin-style runtimes should plug into this boundary rather than changing the chat loop.

## History

heypi does not paste broad adapter history into every model turn. By default, the Pi session receives
only the current triggered message. Set `context.mode` to `"delta"` to include messages since the
last completed trigger in the same conversation.

Older chat is available through the `chat_history` Pi tool. The model can call it when history is
actually needed instead of carrying old Slack/Discord/Telegram context in every request.

## Access

Set `allow` to restrict which adapter events can reach Pi. Lists are exact-match. If a list is
omitted, that field is unrestricted. Denied messages are not acknowledged, queued, or sent to Pi.

```json
{
  "allow": {
    "adapters": ["slack"],
    "accounts": ["T0123456789"],
    "conversations": ["C0123456789"],
    "users": ["U0123456789"]
  }
}
```

## Todo

heypi registers a `todo_update` Pi tool by default. Pi can use it for substantial multi-step work,
and heypi renders the current task list into the active chat thread. Disable it with:

```json
{
  "todo": {
    "enabled": false
  }
}
```

## Memory

heypi registers `memory_store` and `memory_search` Pi tools by default. Memory is stored per
conversation under `.heypi/memory/*.jsonl`. It is not injected into every prompt; Pi stores and
searches it explicitly through tools. Disable it with:

```json
{
  "memory": {
    "enabled": false
  }
}
```

## Audit

heypi stores adapter coordination logs under `.heypi/channels/*.jsonl`. These records are for
admin/audit surfaces; they are not Pi's model transcript.

```ts
import { listAuditChannels, readAuditChannel } from "@hunvreus/heypi";

const channels = await listAuditChannels({ stateDir: ".heypi" });
const records = await readAuditChannel(channels[0].path);
```

Enable the read-only admin HTTP surface with `admin.enabled`. It exposes JSON audit endpoints under
`/admin` by default:

- `GET /admin/health`
- `GET /admin/channels`
- `GET /admin/channels/:key`

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
Thread-capable adapters preserve the source thread id when available, so separate Slack threads or
Telegram forum topics get separate Pi sessions and replies stay in the originating thread.

## Approvals

Approvals run at the Pi tool-call boundary. heypi renders the approval UI through the active adapter,
then the Pi tool call either continues, is rejected by a person, or is blocked by policy.
They are enabled by default. Set `approvals.enabled` to `false` to disable the approval extension.
`layout: "message"` renders a compact text list with buttons. `layout: "card"` uses Slack
attachments and Discord embeds; Telegram keeps text plus inline buttons.

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

Policy predicates receive the attempted tool call and request metadata: `toolName`, `input`,
`adapter`, `account`, `conversation`, `thread`, `actor`, and `approvedTools`. They do not receive the
full Pi transcript or chat history. Use approval decisions for side-effect safety, not model
reasoning.

## Current scope

Included:

- `loadAgent("./agent", options)`
- clean staging for `instructions.md`, `system.md`, `skills/`, `tools/`, and `extensions/`
  into Pi-native resource names and folders
- local runtime workspace selection
- exact-match adapter/account/conversation/user allowlists before Pi work is queued
- thread-aware session keys and reply targets for thread-capable adapters
- Pi session creation through `@earendil-works/pi-coding-agent`
- local adapter for tests and embedding
- webhook adapter for simple HTTP ingress
- Slack Socket Mode adapter shell with replies, reactions, and approval buttons
- Discord adapter shell with mention/DM normalization, typing acknowledgements, replies, and approval
  buttons
- Telegram adapter shell with polling, mention/DM normalization, typing acknowledgements, replies, and
  approval buttons
- approval message rendering and Pi tool-call approval extension
- programmable approval policies with command classification
- `chat_history` and `chat_reply` Pi tools for explicit older-context lookup and sparse progress updates
- `todo_update` Pi extension for visible task progress
- `memory_store` and `memory_search` Pi tools for durable explicit memory
- audit helpers for heypi-owned adapter coordination logs
- read-only admin HTTP audit endpoints

Not included yet:

- richer admin UI and non-local runtime providers

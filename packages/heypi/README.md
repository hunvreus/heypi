# heypi

Pi-native chat adapters for team agents.

heypi is a thin product shell around Pi. Pi owns the model loop, session state, compaction, retries,
tools, extensions, and transcript. heypi owns agent folder loading, resource staging, chat adapters,
approval UI, and small adapter coordination.

## Usage

```ts
import { createHeypi, host, loadAgent, local } from "@hunvreus/heypi";

const agent = loadAgent("./agent", {
	model,
	runtime: host({ workspace: "./workspace" }),
});

const app = await createHeypi({
	agent,
	adapters: [local()],
});

await app.start();
```

## Create from a template

Every project under the repository's `examples/` directory is also a standalone template. Create
Codex Tag and install its dependencies with:

```sh
npx @hunvreus/heypi create codex-tag
```

Use a different destination or skip installation when needed:

```sh
npx @hunvreus/heypi create codex-tag my-agent --no-install
```

Run `heypi templates` to list bundled templates after installing the package. Templates declare the
published heypi version they support. Inside this monorepo, pnpm links that same dependency to the
local workspace package when the semver range matches, so the checked-in files are also the files
users receive.

See also:

- [Creating agents](docs/creating-agents.md)
- [Creating custom tools](docs/creating-custom-tools.md)
- [Scheduling plan](docs/scheduling.md)

`createHeypi()` accepts an optional `piHost` factory for tests and future runtime providers. The
factory must return the Pi host contract; heypi still sends chat deltas to Pi instead of running its
own model loop.

Agent resources are file-based:

```text
agent/
  instructions.md
  system.md
  skills/
  tools/
  extensions/
```

During staging, `system.md` is written as Pi's native `SYSTEM.md`, and `instructions.md` is written
as `APPEND_SYSTEM.md`. `skills/` and `extensions/` stay as Pi-discovered resource folders.

Agent configuration lives in code through `loadAgent("./agent", options)`. heypi does not read a
partial JSON config file; models, adapters, approval policies, runtime settings, and feature toggles
share one typed config surface.

The agent folder is copied into a clean Pi-visible bundle under `.heypi`. Pi loads staged resources
from that bundle; heypi does not expose host source paths to the model. Staging excludes `.git`,
`.heypi`, and `node_modules`.

`skills/` and `extensions/` are copied into the staged Pi bundle for Pi-native discovery. Files in
`tools/` are loaded as authored Pi extension files; use that folder for local tool modules that need
to be registered explicitly.

## Runtime

The default runtime is host execution:

```ts
const agent = loadAgent("./agent", {
	runtime: host({ workspace: "./workspace" }),
});
```

If `workspace` is omitted, heypi creates a clean staged workspace under `.heypi`.
Host file tools are constrained to the configured workspace. Host bash starts in that workspace, but
it is not a sandbox: a shell command can still leave the directory unless the operating system
prevents it.

Docker is wired for Pi core file tools and command execution:

```ts
const agent = loadAgent("./agent", {
	runtime: docker({ workspace: "./workspace", image: "node:22-bookworm" }),
});
```

With Docker, `read`, `write`, `edit`, `find`, `grep`, `ls`, and `bash` run against a managed
container with the workspace bind-mounted at `/workspace`. The configured workspace path must be
mountable by Docker; on Docker Desktop, prefer a project directory over a system temp directory.

Provider runtimes should expose the same core tool contract from separate packages:

```ts
import { gondolin } from "@hunvreus/heypi-runtime-gondolin";
```

The contract is uniform: a runtime either owns a core tool or it should not expose that tool. heypi
should not silently fall back to host file or shell access when a sandbox runtime is selected.

Runtime `env` values are visible to model-driven commands. Do not put credentials there unless
leakage is acceptable:

```ts
runtime: host({
	workspace: "./workspace",
	env: {
		CI: "1",
	},
});
```

Secret-safe access should happen through trusted tools/connections or a runtime broker, not raw
runtime env.

## History

heypi does not paste broad adapter history into every model turn. The Pi session receives the
triggering message. Older chat is available through the `chat_history` Pi tool. The model can call it
when history is actually needed instead of carrying old Slack/Discord/Telegram context in every
request.

Adapter hooks may later attach small event-specific context, but broad passive history injection is
not part of the core API.

## Access

Set adapter `allow` rules to restrict which events can reach Pi. Lists are exact-match. If a list is
omitted, that field is unrestricted. Denied messages are not acknowledged, queued, or sent to Pi.

```ts
const adapter = slack({
	token,
	appToken,
	allow: {
		conversations: ["C0123456789"],
		users: ["U0123456789"],
		groups: ["S0123456789"],
		bots: true,
	},
});
```

## Todo

heypi registers a built-in `todo` Pi extension by default. Pi can use it for substantial multi-step
work, while heypi owns task state, status transitions, active timestamps, final cleanup, and adapter
rendering in the active chat thread. Set `todo: false` in `loadAgent()` to disable it.

## Memory

heypi registers a built-in memory Pi extension by default. The `memory` tool adds, replaces, and
removes curated records; `memory_search` performs explicit recall. Records can target general
memory or the user profile and use one of two scopes:

- conversation: local to the active chat surface
- adapter: shared across conversations for the adapter

The extension adds a small, relevant memory snapshot through Pi's context event without modifying
the session transcript. Recalled content is fenced as untrusted reference context. Set
`memory: false` in `loadAgent()` to disable the extension.

## Secrets

heypi registers a `chat_request_secret` Pi tool. The model can ask the active chat user for a
credential without receiving the raw value:

1. heypi creates a pending request with a public key.
2. The user opens `/admin/secret#...` or the hosted static page, enters the secret, and encrypts it
   in the browser.
3. The encrypted reply is submitted to `/admin/secret` or pasted back into chat as
   `!secret:<id>:<payload>`.
4. heypi decrypts in the trusted process and stores the value encrypted at rest under `.heypi`.

Secret replies are intercepted before Pi sees them. The secret is not written into `/workspace` and
is not returned in the tool result. Runtime `env` values are still visible to model-driven commands,
so use them only for trusted local demos. Production credentials should move through trusted-side
tools, connections, or runtime credential brokers.

## Attachments

heypi registers a `chat_attach` Pi tool. The model can send a file reference from the runtime
workspace back to the active chat:

```text
chat_attach({ paths: ["reports/summary.pdf"], text: "Report ready." })
```

Paths must stay inside `/workspace` or `/shared`. Slack, Discord, and Telegram upload local
attachments when their adapter APIs support it; otherwise heypi includes path/link references in the
message text.

Inbound Slack, Discord, and Telegram attachments are copied into the active conversation workspace
under `attachments/{messageId}/...` before the model sees the message. The model receives the
runtime-visible path, not the adapter's transient download URL.

## Audit

heypi stores adapter coordination logs under `.heypi/adapters/*/conversations/*/sessions/*/log.jsonl`.
These records are for admin/audit surfaces; they are not Pi's model transcript.

```ts
import { listAuditConversations, readAuditConversation } from "@hunvreus/heypi";

const conversations = await listAuditConversations({ stateDir: ".heypi" });
const records = await readAuditConversation(conversations[0].path);
```

Enable the admin HTTP surface with `admin: {}` on `loadAgent()`. Browser requests to `/admin` render
a small local dashboard with live jobs, cancel controls, and audit conversation links. JSON clients can use
the endpoints directly:

- `GET /admin/health`
- `GET /admin/jobs`
- `POST /admin/jobs/cancel` with `{ "scope": "active" | "queued" | "all", "reason": "..." }`
- `GET /admin/conversations`
- `GET /admin/conversations/:key`
- `GET /admin/secret`
- `POST /admin/secret` with `{ "reply": "!secret:<id>:<payload>" }`

Loopback admin servers are unauthenticated by default for local development. If admin is bound to a
non-loopback host, configure `admin.token`; requests must include `Authorization: Bearer <token>` or
`X-Heypi-Admin-Token: <token>`.

## Adapters

Local is for tests and embedding:

```ts
const adapter = local();
```

Webhook accepts JSON over HTTP:

```ts
const adapter = webhook({
	port: 4321,
	path: "/webhook",
	secret: process.env.HEYPI_WEBHOOK_SECRET,
});
```

When `secret` is set, clients must send `X-Heypi-Timestamp` and `X-Heypi-Signature`.
The signature is `sha256=<hmac_sha256(secret, timestamp + "." + rawBody)>`. Non-loopback webhook
hosts require a secret.

Slack uses Socket Mode:

```ts
const adapter = slack({
	token: process.env.SLACK_BOT_TOKEN!,
	appToken: process.env.SLACK_APP_TOKEN!,
	admins: { users: ["U_ADMIN"] },
	approvers: { users: ["U_DEPLOYER"] },
	approvals: { layout: "message", timeoutMs: 60_000 },
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
Approvals are opt-in per tool.
`layout: "message"` renders a compact text list with buttons. `layout: "card"` uses Slack
attachments and Discord embeds; Telegram keeps text plus inline buttons.
Adapter-level `admins` and `approvers` decide who can approve. Admins are always accepted as
approvers. If both are omitted, any actor who can reach the approval UI can approve.

Policies are programmable:

```ts
import { approval } from "@hunvreus/heypi";

const agent = loadAgent("./agent", {
	tools: {
		bash: {
			approve: approval.when(({ actor }) => actor?.id !== "admin", "Run bash command."),
		},
	},
});
```

Built-in helpers:

- `approval.never()` allows every call.
- `approval.always(reason)` asks every time.
- `approval.once(reason)` asks once per tool in a session.
- `approval.when(predicate, reason)` asks only when the predicate matches.
- `approval.command(config)` classifies bash commands with `allow`, `approve`, and `block` regexes.

Policy predicates receive the attempted tool call and request metadata: `toolName`, `input`,
`adapter`, `adapterId`, `conversation`, `thread`, `actor`, and `approvedTools`. They do not receive the
full Pi transcript or chat history. Use approval decisions for side-effect safety, not model
reasoning.

## Current scope

Included:

- `loadAgent("./agent", options)`
- clean staging for `instructions.md`, `system.md`, `skills/`, `tools/`, and `extensions/`
  into Pi-native resource names and folders
- local runtime workspace selection
- exact-match conversation/user/group/bot allowlists before Pi work is queued
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
- `chat_history` Pi tool for explicit older-context lookup
- adapter-owned progress updates from normalized Pi/heypi events, configurable with `progress` or
  adapter `events`
- `todo` Pi extension for visible task progress
- built-in `memory` and `memory_search` Pi extension with bounded relevant recall
- audit helpers for heypi-owned adapter coordination logs
- read-only admin HTTP audit and live job endpoints

## Progress

heypi renders transient activity from Pi runtime events. Slack posts an editable `Thinking...`
message immediately when a turn starts, changes it to `Working...` when Pi uses a tool, and removes
it when the turn ends. Discord and Telegram use refreshed native typing indicators. The final answer
is always a separate message.

The built-in todo extension owns a second editable message. Activity and todo updates never compete
for the same message: activity is transient, while the settled todo list remains visible.

```ts
slack({
	token,
	appToken,
	progress: true,
});
```

Set adapter `progress: false` to disable activity and visible todo rendering. The Pi todo tool remains
available unless the agent sets `todo: false`.

The current built-in text progress is intentionally coarse: `Thinking...` before tool work and
`Working...` once Pi starts using tools.

Adapters can override individual event handlers:

```ts
import { slack, statusEvents } from "@hunvreus/heypi";

slack({
	token,
	appToken,
	events: {
		...statusEvents(),
		"tool.started": false,
		"turn.started": (_event, { status }) => status?.replace("Checking..."),
	},
});
```

Stable events are `message.accepted`, `turn.started`, `tool.started`, `todo.changed`,
`message.completed`, `turn.canceled`, `turn.failed`, `message.queued`, `message.steered`, and
`message.rejected`. Pi-derived events are normalized before adapters see them.

Slack reactions are available through the same event context instead of a separate reaction setting:

```ts
slack({
	token,
	appToken,
	events: {
		...statusEvents(),
		"message.accepted": async (event, context) => {
			context.status?.replace("Thinking...");
			if (event.message.mentioned) await context.react?.("eyes");
		},
	},
});
```

## Busy conversations

Adapters default to durable FIFO queueing when a conversation already has an active Pi turn. Select
another policy with `busy`:

```ts
slack({
	token,
	appToken,
	busy: "queue", // "queue" | "steer" | "reject"
});
```

- `queue` stores the new turn and runs it after the active turn.
- `steer` sends the message to Pi's active session through `session.steer()`.
- `reject` declines the message without creating a turn.

The default responses are adapter events. Override or disable `message.queued`, `message.steered`,
or `message.rejected` to customize their user-facing behavior.

Not included yet:

- richer admin UI and non-local runtime providers

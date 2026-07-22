<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/logo-white.svg">
    <source media="(prefers-color-scheme: light)" srcset="docs/assets/logo-black.svg">
    <img alt="heypi" src="docs/assets/logo-black.svg" width="320">
  </picture>
</p>

# heypi

Pi-native chat adapters for team agents.

heypi is a thin product shell around Pi. Pi owns the model loop, session state, compaction, retries,
tools, extensions, and transcript. heypi owns agent folder loading, resource staging, chat adapters,
approval UI, and small adapter coordination.

[Documentation](https://heypi.dev/docs/) · [Quickstart](https://heypi.dev/docs/getting-started/) ·
[GitHub](https://github.com/hunvreus/heypi)

## Install

```sh
npm install @hunvreus/heypi
```

## Usage

```ts
import { host, loadAgent, local, modelFromEnv, runHeypi } from "@hunvreus/heypi";

const agent = loadAgent("./agent", {
	model: modelFromEnv(),
	runtime: host({ workspace: "./workspace" }),
});

await runHeypi(agent, [local()]);
```

`modelFromEnv()` reads `HEYPI_MODEL` in `provider/model` form. Provider credentials follow Pi's
normal authentication and environment-variable support.

## Create from a template

Every project under the repository's `examples/` directory is also a standalone template. Create
Codex Tag and install its dependencies with:

```sh
npm create heypi@latest -- codex-tag
```

Use a different destination or skip installation when needed:

```sh
npm create heypi@latest -- codex-tag my-agent --no-install
```

The equivalent lower-level command is `npx @hunvreus/heypi create codex-tag`. Run
`heypi templates` to list bundled templates after installing the package. Templates declare the
published heypi version they support. Inside this monorepo, pnpm links that same dependency to the
local workspace package when the semver range matches, so the checked-in files are also the files
users receive.

## CLI setup helpers

The CLI can validate configured adapters and discover the IDs needed by adapter config without
starting an agent:

```sh
heypi check

heypi slack check
heypi slack channels --query project --private
heypi slack users --query alice
heypi slack manifest
heypi slack env-example

heypi discord check
heypi discord guilds
heypi discord channels --guild 123456789
heypi discord invite
heypi discord env-example

heypi telegram check
heypi telegram webhook-info
heypi telegram listen --timeout 20 --force
heypi telegram env-example
```

Commands load `.env` and then `.env.local`; exported environment variables take precedence. Use
`--env-file path` to load a different file and `--json` for machine-readable output. Output and
errors redact configured tokens, secrets, passwords, webhook secrets, and token-bearing URLs.

These commands only read platform state and print config values or snippets. They do not modify
source or environment files. `telegram listen` is the exception to passive inspection: it calls
`getUpdates`, which can consume updates intended for a running adapter, so it requires `--force` and
refuses to run while a webhook is configured.

## Documentation

- **Getting started:** [Introduction](docs/index.md), [quickstart](docs/getting-started/index.md)
- **Configuration:** [Overview](docs/configuration/index.md), [runtimes](docs/configuration/runtimes.md), [approvals](docs/configuration/approvals.md), [scheduling](docs/configuration/scheduling.md)
- **Adapters:** [Overview](docs/adapters/index.md), [Slack](docs/adapters/slack.md), [Discord](docs/adapters/discord.md), [Telegram](docs/adapters/telegram.md), [webhook](docs/adapters/webhook.md)
- **Guides:** [Deployment](docs/guides/deployment.md), [custom tools](docs/guides/custom-tools.md), [custom adapters](docs/guides/custom-adapters.md), [custom runtimes](docs/guides/custom-runtimes.md)
- **Reference:** [API](docs/reference/index.md), [CLI](docs/reference/cli.md), [architecture](docs/reference/architecture.md)

These files are packaged with `@hunvreus/heypi`. Browse the rendered version at
[heypi.dev/docs](https://heypi.dev/docs/).

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
  schedules/
```

During staging, `system.md` is written as Pi's native `SYSTEM.md`, and `instructions.md` is written
as `APPEND_SYSTEM.md`. `skills/` and `extensions/` stay as Pi-discovered resource folders.

Agent configuration lives in code through `loadAgent("./agent", options)`. heypi does not read a
partial JSON config file; models, adapters, approval policies, runtime settings, and feature toggles
share one typed config surface.

The agent folder is copied into a clean Pi-visible bundle under `.heypi`. Pi loads staged resources
from that bundle; heypi does not expose host source paths to the model. Staging excludes `.git`,
`.heypi`, and `node_modules`.

`skills/` and `extensions/` are copied into the staged Pi bundle for Pi-native discovery. The full
skill tree, including scripts and assets, is exposed to runtime tools at managed
`/agent/skills`. Sandboxed local providers mount it read-only; host and remote providers use
disposable copies that never synchronize changes into staged agent content. Files in `tools/` are
loaded as authored Pi extension files. `schedules/` contains trusted application code and is loaded
by heypi without being exposed as a Pi resource.

## Storage

The default state root is `.heypi`. Each adapter ID gets an isolated area containing:

- one writable `/shared` root for deliberate reuse across that adapter's conversations;
- one workspace per channel, DM, or equivalent chat surface;
- one Pi session and heypi audit log per independent conversation or thread;
- conversation, active-user, and adapter-shared memory files.

Slack threads in one channel share its workspace but keep separate Pi sessions. Discord and
Telegram use the equivalent channel, DM, reply-chain, thread, or topic identifiers. Heypi serializes
operations that touch the same workspace or shared root without collapsing independent chat queues.

## Runtime

The default runtime is host execution. Omitting `runtime` logs a security warning because model-driven
shell commands then execute on the host. Configure it explicitly when that access is intentional:

```ts
const agent = loadAgent("./agent", {
	runtime: host({ workspace: "./workspace" }),
});
```

If `workspace` is omitted, heypi creates a clean staged workspace under `.heypi`.
Host file tools are constrained to the configured workspace. Host bash starts in that workspace, but
it is not a sandbox: a shell command can still leave the directory unless the operating system
prevents it. Unix host execution requires `/bin/bash`; Windows uses Pi's Git Bash discovery.

Docker is wired for Pi core file tools and command execution:

```ts
const agent = loadAgent("./agent", {
	runtime: docker({ workspace: "./workspace", image: "node:22-bookworm" }),
});
```

With Docker, `read`, `write`, `edit`, `find`, `grep`, `ls`, and `bash` run against a managed
container with the workspace bind-mounted at `/workspace`. The configured workspace path must be
mountable by Docker; on Docker Desktop, prefer a project directory over a system temp directory.
Docker itself does not provide a shell: the selected image does. Heypi invokes `/bin/bash -lc`, so
custom images must include Bash. The default `node:22-bookworm` image includes it.

Additional runtimes expose the same core tool contract from separate packages:

```ts
import { gondolin } from "@hunvreus/heypi-runtime-gondolin";

const agent = loadAgent("./agent", {
	runtime: gondolin({ workspace: "./workspace" }),
});
```

Available providers:

- `@hunvreus/heypi-runtime-just-bash`: in-process shell interpreter with host directories mounted
  through `just-bash`'s confined filesystem. Network access is disabled unless configured explicitly.
- `@hunvreus/heypi-runtime-gondolin`: local QEMU micro-VM with `/workspace` and `/shared` bind-mounted;
  requires Node 23.6+ and QEMU.
- `@hunvreus/heypi-runtime-vercel`: creates and stops a Vercel Sandbox, synchronizing durable host
  roots into the sandbox and materializing remote writes back to the host.
- `@hunvreus/heypi-runtime-cloudflare`: uses a caller-owned Cloudflare `ISandbox`, creates an explicit
  execution session, and deletes that session during cleanup. Configure the SDK's RPC transport.

The contract is uniform: a runtime owns all seven Pi core tools and never falls back to host file or
shell access. Vercel and Cloudflare refresh files before each turn and synchronize them after each
bash command so `chat_attach` can read generated files. Synchronization preserves modes and
root-confined symlinks, propagates remote deletions, and leaves unrelated host files intact.
The host, Docker, Gondolin, Vercel, and Cloudflare providers execute Bash commands with Bash;
`just-bash` uses its in-process Bash-compatible interpreter. Custom Docker and Gondolin images must
provide the configured shell.

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

DMs keep one persistent Pi session per chat. In public channels, each top-level mention starts a new
Pi session. Slack thread replies continue the thread session; Discord and Telegram replies to bot
messages continue the corresponding reply-chain session. Discord native threads and Telegram forum
topics remain delivery containers, so a new top-level mention inside one starts a new session.

Adapter hooks may later attach small event-specific context, but broad passive history injection is
not part of the core API.

## Access

Set adapter `allow` rules to restrict which events can reach Pi. Lists are exact-match. If a list is
omitted, that field is unrestricted. Denied messages are not acknowledged, queued, or sent to Pi.

```ts
const adapter = slack({
	token,
	appToken,
	reaction: "eyes",
	allow: {
		dms: false,
		channels: ["C0123456789"],
		users: ["U0123456789"],
		bots: true,
	},
});
```

`dms` defaults to `true`. `channels` applies only to non-DM destinations; omit it to allow all
channels or set it to `[]` to allow none. Discord native threads inherit their parent channel's
permission. Telegram forum topics inherit their group chat's permission. User rules are applied in
addition to the destination rule. The generic `groups` rule applies only to custom adapters that
populate `message.user.groups`; built-in adapters do not resolve external group memberships.

## Todo

heypi registers a built-in `todo` Pi extension by default. Pi can use it for substantial multi-step
work, while heypi owns task state, status transitions, active timestamps, final cleanup, and adapter
rendering in the active chat thread. Set `todo: false` in `loadAgent()` to disable it.

## Memory

heypi registers a built-in memory Pi extension by default. The `memory` tool adds, replaces, and
removes curated records; `memory_search` performs explicit recall. Records use one of three
destinations:

- conversation: local to the active chat surface and used by default
- user: the active user's profile, isolated from other users on the adapter
- shared: reusable memory shared across conversations for the adapter

The extension adds a small, relevant memory snapshot through Pi's context event without modifying
the session transcript. User profiles are resolved from the active message, including when different
users participate in one thread. Recalled content is fenced as untrusted reference context. Set
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

Adapter `attachments` policy can restrict `maxBytes`, `timeoutMs`, `mimeTypes`, and remote `hosts`,
and configure bounded download `retry`. Built-in adapters validate every redirect against their
platform file hosts and remove partial files when a batch fails. Telegram's adapter-level
`timeoutMs` bounds Bot API requests independently from attachment downloads.

## Audit

heypi stores adapter coordination logs under `.heypi/adapters/*/conversations/*/sessions/*/log.jsonl`.
These records are for admin/audit surfaces; they are not Pi's model transcript.
Approval requests and resolutions are stored in this HeyPi log as the canonical authorization ledger.
Pi session JSONL remains the execution trace; heypi only mirrors reduced, non-authoritative approval
annotations into Pi for correlation.
HeyPi does not mirror message routing or turn lifecycle records into Pi; those remain in the HeyPi
conversation log and are joined to Pi sessions through `heypi.turn`.

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
- `GET /admin/pi-sessions/:key`
- `GET /admin/pi-sessions/:key/:id`
- `GET /admin/secret`
- `GET /admin/schedules`
- `POST /admin/schedules/run` with `{ "id": "reports/weekly" }`
- `POST /admin/secret` with `{ "reply": "!secret:<id>:<payload>" }`

Loopback admin servers are unauthenticated by default for local development. If admin is bound to a
non-loopback host, configure `admin.token`; requests must include `Authorization: Bearer <token>` or
`X-Heypi-Admin-Token: <token>`. Wildcard binds such as `host: "0.0.0.0"` also require an explicit
`hosts` allowlist containing the accepted HTTP hostnames.

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

Send a stable, non-empty `id` with each message so transport retries can be deduplicated:

```json
{
	"id": "request-123",
	"text": "Summarize the latest report",
	"conversation": "reports",
	"user": { "id": "service", "name": "Reporting service" }
}
```

When `secret` is set, clients must send `X-Heypi-Timestamp` and `X-Heypi-Signature`.
The signature is `sha256=<hmac_sha256(secret, timestamp + "." + rawBody)>`. Non-loopback webhook
hosts require a secret. A successful request returns `202` after durable intake; processing
continues asynchronously.

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
When an interactive approval is required, heypi writes `approval_requested` before posting the
adapter UI and writes `approval_resolved` before allowing the tool to continue. If either canonical
write fails, the tool is blocked. Pi receives `heypi.approval.requested` and
`heypi.approval.resolved` custom entries with `authoritative: false` and no full tool input.
These dotted values are Pi custom-entry identifiers, not HeyPi event discriminants; public events,
conversation records, and logger events use flat snake_case.
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

## Tools

The `tools` map changes Pi tools by name:

```ts
const agent = loadAgent("./agent", {
	tools: {
		bash: { approve: approval.command() },
		write: false,
	},
});
```

- `false` disables a built-in or discovered tool.
- `{ approve }` adds an approval policy to that tool.
- A Pi `ToolDefinition` registers a code-defined tool.

Files under `agent/tools/` remain the preferred home for authored tools. Invalid map entries fail at
startup instead of being treated as partial tool configuration.

## Current scope

Included:

- `loadAgent("./agent", options)`
- clean staging for `instructions.md`, `system.md`, `skills/`, `tools/`, and `extensions/`
  into Pi-native resource names and folders
- host and Docker runtimes, plus separate Gondolin, just-bash, Vercel, and Cloudflare providers
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
- adapter-owned activity from normalized Pi/heypi events, configurable with Slack `status`,
  Discord/Telegram `typing`, or adapter `events`
- `todo` Pi extension for visible task progress
- built-in `memory` and `memory_search` Pi extension with bounded relevant recall
- audit helpers for heypi-owned adapter coordination logs
- admin HTTP audit, live job controls, and schedule endpoints
- code-owned cron schedules and schedule audit

## Progress

heypi renders transient activity with each chat platform's native surface. Slack calls
`assistant.threads.setStatus` with `Thinking...` when a message is accepted and `Working...` when Pi
starts a tool. Discord and Telegram refresh their native typing indicators. No adapter posts a chat
message for transient activity.

Slack immediately acknowledges app mentions with an `eyes` reaction before staging attachments. Set
`reaction` to another Slack emoji name or `false` to disable it. The Slack app needs the
`reactions:write` scope.

Slack clears its native status while an approval is pending and restores it when work resumes. Todo
updates remain a separate editable message; Slack restores the native status after posting or
updating that message. Queue, steer, and reject acknowledgements also restore `Working...`. Posting
the terminal reply clears the status without a separate API call.

```ts
slack({
	token,
	appToken,
	status: true,
});
```

Set Slack `status: false` to disable native assistant activity. Visible Slack todo updates remain
enabled unless the agent sets `todo: false`. Discord and Telegram expose the equivalent native
activity toggle as `typing`.

Adapters can override individual event handlers:

```ts
import { slack } from "@hunvreus/heypi";

slack({
	token,
	appToken,
	events: {
		tool_started: false,
	},
});
```

Custom Slack lifecycle handlers replace the built-in handler for that event. Set an event to `false`
to disable it.

Stable events are `message_accepted`, `turn_started`, `tool_started`, `todo_changed`,
`message_completed`, `turn_canceled`, `turn_failed`, `message_queued`, `message_steered`, and
`message_rejected`. Pi-derived events are normalized before adapters see them.

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

The default responses are adapter events. Override or disable `message_queued`, `message_steered`,
or `message_rejected` to customize their user-facing behavior.

Not included yet: distributed scheduling, brokered runtime credentials, and a richer operational
admin UI.

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/heypi-white.png">
    <source media="(prefers-color-scheme: light)" srcset="docs/assets/heypi-black.png">
    <img alt="heypi" src="docs/assets/heypi-black.png" width="320">
  </picture>
</p>

# heypi

Chat agents on top of [Pi](https://github.com/earendil-works/pi).

heypi adds adapters, persistence, governed tools, approvals, and runtime-backed workspace access to Pi.

See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the process model, module boundaries, request flow, and security model.

## Features

- Pi-backed agent loop via `@earendil-works/pi-coding-agent`
- Slack adapter with Socket Mode and HTTP receiver modes
- Telegram long-polling adapter
- Discord gateway adapter
- Generic HTTP webhook adapter
- SQLite store for thread routes, message audit/search rows, turns, calls, approvals, scheduled jobs, job runs, and locks
- Pi-compatible tools: `bash`, `read`, `write`, `edit`, `grep`, `find`, `ls`, `history`
- Static runtime selection: `just-bash`, `docker-bash`, `guarded-bash`, or `host-bash`
- Human approval flow for tool calls that require confirmation
- Cron and heartbeat jobs for proactive agent turns
- Runtime-backed attachment handling
- JSON or pretty console logging

## Install

```bash
npm install @hunvreus/heypi
```

## Minimal App

```ts
import { agentFrom, createHeypi, slack, sqliteStore, workspace } from "@hunvreus/heypi";

const app = createHeypi({
	store: sqliteStore({ path: "./heypi.db" }),
	adapters: [
		slack({
			botToken: process.env.SLACK_BOT_TOKEN!,
			mode: "socket",
			appToken: process.env.SLACK_APP_TOKEN!,
			allow: { channels: ["C123"] },
			trigger: "mention",
			reply: "thread",
		}),
	],
	agent: agentFrom("./agent", { model: "openai/gpt-5-mini" }),
	runtime: {
		name: "just-bash",
		root: workspace("./workspace"),
	},
	jobs: [
		{
			id: "daily-checkin",
			kind: "heartbeat",
			everyMs: 24 * 60 * 60 * 1000,
			scope: { adapters: ["slack"] },
			prompt: "Check whether this thread needs follow-up.",
		},
	],
	approval: {
		approvers: ["U123456"],
		expiresInMs: 10 * 60 * 1000,
	},
});

await app.start();
```

`OPENAI_API_KEY` is read by Pi through its normal provider auth path.

## Agent Folder

`agentFrom("./agent")` loads this convention:

```text
agent/
  SOUL.md
  SYSTEM.md
  AGENTS.md
  skills/
  extensions/
```

Missing files/folders are ignored. If `SOUL.md` is missing, heypi uses this built-in default:

```text
You are a concise, practical assistant.
Answer directly and accurately. Say when you are uncertain or blocked.
Use plain language and keep responses focused on the user's goal.
```

- `SOUL.md` defines identity, role, voice, and communication style.
- `AGENTS.md` defines operating rules, domain/project instructions, and standing orders.
- `SYSTEM.md` is an advanced full override for heypi's runtime prompt. Avoid it unless you intentionally want to replace the built-in tool/protocol guidance.

You can override everything in code:

```ts
import { coreTools } from "@hunvreus/heypi";

agentFrom("./agent", {
	id: "devops",
	model: "openai/gpt-5-mini",
	soul: "You are a concise DevOps assistant.",
	prompt: "Prefer safe, auditable actions.",
	context: [
		async ({ provider, channel, actorName }) => ({
			title: "Runtime context",
			text: [`Provider: ${provider}`, `Current channel: ${channel}`, actorName ? `Sender: ${actorName}` : undefined]
				.filter(Boolean)
				.join("\n"),
		}),
	],
	skills: ["./shared/skills"],
	extensions: ["./agent/extensions"],
	tools: [...coreTools(), myTool],
});
```

Pass `model` explicitly or set `HEYPI_MODEL`. heypi does not choose a provider/model implicitly.
Use `context` for small dynamic system-prompt blocks such as known hosts, tenant metadata, user profile, or channel policy. Context providers run once per agent turn. heypi also injects current channel context automatically, including provider, channel/thread ids or names when available, and sender id or name when available.

Default runtime prompt:

```text
Use available tools when needed. Prefer the narrowest available tool that directly matches the task. Do not say you used a tool unless you actually called it.

Approvals are handled by the runtime. Do not ask users to approve tool calls in plain text.
```

heypi appends short conditional guidance for active core tools. For example, when both shell and dedicated file/search tools are active, it tells the model to prefer dedicated file/search tools for file exploration and use shell tools for shell-specific work.

## Tools And Approvals

heypi exposes its own Pi-compatible core tools instead of Pi's raw built-ins. Omit `tools` to use the default core tools. If you pass `tools`, include `coreTools()` explicitly:

```ts
import { agentFrom, commandConfirm, coreTools } from "@hunvreus/heypi";

agentFrom("./agent", {
	model: "openai/gpt-5-mini",
	tools: [
		...coreTools(),
		myTool,
	],
});
```

Core tools are `bash`, `read`, `write`, `edit`, `grep`, `find`, `ls`, and `history`. By default, `bash` uses `commandConfirm()` while file and search tools run without approval. Customize or disable core tools with the same tool-shaped config:

```ts
tools: [
	...coreTools({
		bash: { confirm: commandConfirm({ approve: [/\bmake deploy\b/] }) },
		write: false,
		edit: false,
	}),
	myTool,
];
```

Use `bash: true` to enable bash without command confirmation.

Add custom tools with Pi `ToolDefinition` objects or the `tool()` helper. Raw Pi tools are supported for non-confirmed tools. Use `tool()` when a custom tool needs approval so heypi can replay the call after approval:

```ts
import { tool } from "@hunvreus/heypi";
import { Type } from "@sinclair/typebox";

const pageService = tool<{ service: string; reason: string }>({
	name: "page_service",
	description: "Record a service page request.",
	parameters: Type.Object({
		service: Type.String(),
		reason: Type.String(),
	}),
	confirm: ({ service }) => ({ message: `Page ${service}.` }),
	execute: async ({ service, reason }) => `page recorded: service=${service} reason=${reason}`,
});
```

Text fallback for approvals works on every adapter:

```text
approvals
approve <approval-id>
deny <approval-id>
status
status <call-id>
cancel <turn-id-or-trace>
```

Slack, Telegram, and Discord also render provider-native buttons. Approval cards are updated in place with `✅ Approval ... approved by ...` or `⛔ Approval ... rejected by ...`, while preserving the original approval details and removing the buttons. If an approved call continues running, the adapter sends a follow-up progress/result message instead of blocking the button acknowledgement.

The `approvals` chat command lists pending approvals. If `approval.approvers` is configured, only those actors can use it; otherwise it lists pending approvals in the current thread only.

See [`docs/EXTENDING.md`](docs/EXTENDING.md) for custom tools, confirmation, and command risk classification.

## Adapters

Slack, Telegram, and Discord adapters handle inbound messages, provider-native approval buttons, progress updates, and outbound attachments.

### Slack

Slack supports Socket Mode for local development:

```ts
slack({
	botToken: process.env.SLACK_BOT_TOKEN!,
	mode: "socket",
	appToken: process.env.SLACK_APP_TOKEN!,
	allow: {
		teams: ["T123"],
		channels: ["C123"],
		users: ["U123"],
		dms: true,
	},
	trigger: "mention",
	reply: "thread",
	streaming: true,
});
```

Use HTTP mode for production deployments with a public Slack Events/Interactivity URL:

```ts
slack({
	botToken: process.env.SLACK_BOT_TOKEN!,
	signingSecret: process.env.SLACK_SIGNING_SECRET!,
	mode: "http",
	port: Number(process.env.PORT ?? 3000),
	path: "/slack/events",
	allow: { channels: ["C123"] },
	trigger: "mention",
	reply: "thread",
});
```

In Slack app settings:

- Socket Mode: enable Socket Mode and create an app-level token with `connections:write`.
- HTTP mode: set Event Subscriptions and Interactivity URLs to `https://<host>/slack/events`, or to the custom `path` you configured.

All Slack modes use the same bot token, message handling, approvals, and reply behavior. HTTP mode starts Bolt's built-in Node HTTP receiver.
Socket Mode does not require a signing secret unless you also use HTTP interactivity. HTTP mode requires `signingSecret` to verify Slack requests.

See [`docs/SLACK.md`](docs/SLACK.md) for scopes, events, manifests, and common setup failures.

Inbound Slack messages can be restricted with `allow`. Omitted `teams`, `channels`, and `users` allow all delivered events for that dimension. `channels` applies to non-DM channels only. `allow.dms` defaults to `true`. `trigger` defaults to `"mention"` for top-level channel messages; thread replies and accepted DMs trigger by default. Use `threadTrigger: "mention"` to require mentions in thread replies. Slack progress defaults to an immediate `Thinking...` message; top-level channel messages also get an `eyes` reaction. Thread replies, DMs, and approval continuations do not get the reaction.

### Telegram

Telegram uses long polling:

```ts
telegram({
	token: process.env.TELEGRAM_BOT_TOKEN!,
	allow: {
		chats: ["-1001234567890"],
		users: ["8734062810"],
		dms: true,
	},
	trigger: "mention",
	streaming: true,
});
```

See [`docs/TELEGRAM.md`](docs/TELEGRAM.md) for BotFather setup and chat discovery.

Inbound Telegram messages can be restricted with `allow`. Omitted `chats` and `users` allow all delivered updates for that dimension. `chats` applies to groups/channels only. `allow.dms` defaults to `true`. `trigger` defaults to `"mention"` for top-level groups; forum topic replies and accepted private chats trigger by default. Use `threadTrigger: "mention"` to require mentions in forum topics. Telegram progress defaults to an immediate `Thinking...` message when streaming is off.

### Discord

Discord uses the gateway through `discord.js`:

```ts
import { discord } from "@hunvreus/heypi";

discord({
	token: process.env.DISCORD_BOT_TOKEN!,
	allow: {
		guilds: ["123456789012345678"],
		channels: ["234567890123456789"],
		users: ["345678901234567890"],
		dms: true,
	},
	trigger: "mention",
	streaming: true,
});
```

See [`docs/DISCORD.md`](docs/DISCORD.md) for bot setup, intents, invite URLs, and ID discovery.

Inbound Discord messages can be restricted with `allow`. Omitted `guilds`, `channels`, and `users` allow all delivered events for that dimension. `channels` applies to non-DM channels only. `allow.dms` defaults to `true`. `trigger` defaults to `"mention"` for top-level guild channels; Discord thread channels and accepted DMs trigger by default. Use `threadTrigger: "mention"` to require mentions in Discord threads. Discord progress defaults to an immediate `Thinking...` message when streaming is off.

### Webhook

Webhook exposes a generic JSON HTTP adapter for internal systems:

```ts
import { webhook } from "@hunvreus/heypi";

webhook({
	secret: process.env.HEYPI_WEBHOOK_SECRET!,
	port: 3000,
	host: "127.0.0.1",
	path: "/webhook",
	replyHosts: ["internal.example.com"],
});
```

Send a message:

```bash
curl -X POST http://localhost:3000/webhook/messages \
  -H "authorization: Bearer $HEYPI_WEBHOOK_SECRET" \
  -H "content-type: application/json" \
  -d '{"user":"alice@example.com","text":"Start incident review"}'
```

Missing `threadId` creates a new server-side thread and returns it with a `runId`. Follow-ups, status checks, approvals, denials, and cancels reuse that `threadId`.

```bash
curl http://localhost:3000/webhook/threads/<threadId>/runs/<runId> \
  -H "authorization: Bearer $HEYPI_WEBHOOK_SECRET"
```

Webhook is async-first: requests return `202` while the turn runs. Pass `replyUrl` to receive a callback when the run finishes, or pass `sync: true` for short calls with a strict timeout. `replyUrl` hosts must be listed in `replyHosts`; omitted `replyHosts` rejects callbacks. Webhook binds to `127.0.0.1` by default; set `host: "0.0.0.0"` explicitly only behind a gateway or firewall.

See [`docs/WEBHOOK.md`](docs/WEBHOOK.md) for auth, threading, async callbacks, sync mode, and approvals.

Streaming is opt-in. Use `streaming: true` for the defaults, or pass `{ intervalMs, minChars, maxFailures }` to tune it. When enabled, heypi posts a draft reply and edits it at a bounded cadence while Pi emits text deltas. Confirmed tool calls stop the draft stream before approval buttons are sent; after approval, continuation can start a new draft stream.

Slack still shows its immediate `Thinking...` progress message while streaming, and top-level channel messages get the configured reaction. Telegram and Discord suppress progress messages while streaming is active to avoid duplicate visible replies.

Adapter delivery is serialized by default and retries provider rate limits with backoff. Ambiguous timeouts are not retried for non-idempotent sends such as new chat messages or file uploads, because the provider may already have accepted the request.

The default per-adapter delivery pacing should be enough for most apps. Override it only when a provider needs different pacing:

```ts
slack({
	// ...
	delivery: { intervalMs: 500, retries: 2 },
});
```

Custom adapters implement:

```ts
type Adapter = {
	name?: string;
	start(input: { handler: Handler; status?: Status; logger: Logger; attachments?: AttachmentStore }): Promise<void>;
	send?(target: AdapterTarget, out: Outbound, input?: AdapterStart): Promise<void>;
	stop?(): Promise<void>;
};
```

`send()` is required for cron and heartbeat jobs because scheduled turns are initiated by heypi, not by an inbound provider message.

## Scheduling

heypi has two scheduled event types:

- `cron`: run an agent turn at `{ at }`, `{ everyMs }`, or `{ cron, timezone }`.
- `heartbeat`: run proactive turns over matching known chats, optionally gated by `idleMs`.

Examples:

```ts
jobs: [
	{
		id: "weekly-ops",
		kind: "cron",
		schedule: { cron: "0 9 * * 1", timezone: "America/Los_Angeles" },
		target: { adapter: "slack", channel: "C123" },
		prompt: "Run the weekly ops review.",
	},
	{
		id: "daily-workout",
		kind: "heartbeat",
		everyMs: 24 * 60 * 60 * 1000,
		idleMs: 8 * 60 * 60 * 1000,
		scope: { adapters: ["telegram"] },
		prompt: "Run the daily workout check-in.",
	},
];
```

Defaults:

- Missing `scope` means all known chats are eligible.
- `heartbeat` without `target` sends to each matched chat.
- `cron` without `target` runs only when exactly one target can be resolved.
- Slack cron jobs should usually set `target`; Telegram personal bots can use known chats after bootstrap.

See [`docs/SCHEDULING.md`](docs/SCHEDULING.md).

## CLI

heypi ships a separate CLI for setup checks and job inspection:

```bash
pnpm exec heypi check --env .env --db ./heypi.db
pnpm exec heypi slack check --env examples/slack-devops/.env
pnpm exec heypi telegram observe --env examples/telegram-workout/.env
pnpm exec heypi discord observe --env .env
pnpm exec heypi approvals list --db ./heypi.db
pnpm exec heypi jobs list --db examples/telegram-workout/heypi.db
```

The CLI is not used by `createHeypi()` at runtime. See [`docs/CLI.md`](docs/CLI.md).

## Runtime

Runtime selection is static per app.

```ts
runtime: {
	name: "just-bash", // "docker-bash" | "guarded-bash" | "host-bash"
	root: workspace("./workspace"),
	maxConcurrent: 12,
	maxConcurrentPerChat: 1,
	timeoutMs: 120_000,
	limits: {
		maxFileBytes: 1_000_000,
		maxScanBytes: 5_000_000,
		maxEntries: 10_000,
	},
	justBash: {
		// Network is off by default. Enable it only when the agent needs curl.
		network: {
			allowedUrlPrefixes: ["https://docs.example.com"],
			// or, for trusted/dev agents:
			// dangerouslyAllowFullInternetAccess: true,
		},
		python: false,
		javascript: false,
	},
	docker: {
		image: "ubuntu:24.04",
		network: "none",
		// Defaults to the current uid:gid when available.
		user: "1000:1000",
	},
	hostEnv: {
		CI: "true",
	},
}
```

Command confirmation is configured on the `bash` core tool:

```ts
tools: [
	...coreTools({
		bash: {
			confirm: commandConfirm({
				allow: [/^curl -I https:\/\/status\.example\.com\b/],
				approve: [/\bmake deploy\b/],
				block: [/\bgh repo delete\b/],
			}),
		},
	}),
]
```

Custom `block` patterns and built-in hard blocks win first. Shell commands are parsed into simple command segments before `allow` patterns are applied, so an allowed `curl` segment cannot allow a separate `ufw`, `docker`, or other risky segment in the same compound command. Parse failures fail closed and require approval. Use `coreTools({ bash: true })` when you want bash enabled without command confirmation.

`just-bash` is the default production runtime. Network access is disabled by default; configure `runtime.justBash.network` when bash should be able to use `curl` for public docs or APIs. Prefer `allowedUrlPrefixes` for team bots. Use `dangerouslyAllowFullInternetAccess` only for trusted/dev agents.

`docker-bash` runs `bash` in `docker run --rm` with the workspace mounted at `/workspace`; file tools still use heypi's bounded runtime file operations. Docker commands run as the current uid/gid by default when Node exposes them; set `docker.user: false` to disable that or pass an explicit user string. Custom `docker.args` can weaken or defeat container isolation, so review them carefully. `guarded-bash` and `host-bash` execute host bash from the configured workspace root; they are not OS isolation. Host runtimes receive a minimal environment by default; pass `hostEnv` to expose specific variables.

Regex command classification is a guardrail, not a sandbox. Use `just-bash` or `docker-bash` for team-facing agents.

Runtime file tools enforce path containment, symlink escape checks, and size limits by default: 1 MB per file, 5 MB per scan, and 10,000 traversed entries. Override `runtime.limits` for larger workspaces.

Attachments are limited to 25 MB by default, including streamed provider downloads. Override with `attachments: { maxBytes }`, or pass `attachments: { store }` for custom storage. Inbound images are passed to Pi as image inputs, and text-like files are inlined into the prompt. Optional document conversion can be enabled for PDF, Office, and ebook-style formats:

```ts
attachments: {
	process: {
		documents: {
			// Defaults to process.env.HEYPI_DOCUMENT_CONVERTER or "heypi-convert-document".
			command: "./bin/heypi-convert-document",
			timeoutMs: 15_000,
			maxBytes: 10_000_000,
			maxOutputBytes: 1_000_000,
			// Defaults to PATH only so API keys/secrets are not inherited.
			// Set env explicitly if your wrapper needs more.
			env: { PATH: process.env.PATH ?? "" },
		},
	},
}
```

The document converter is not bundled. Provide a local wrapper command yourself, preferably in a constrained environment. The wrapper may use MarkItDown, a JS converter, Docker, or another implementation; it must accept one local file path and print Markdown to stdout. Do not enable network, plugin, or cloud conversion for untrusted chat attachments unless you have sandboxed and reviewed that path. If conversion fails or is disabled, heypi keeps the original attachment reference.

## Shutdown

Call `app.stop()` during process shutdown so adapters and the scheduler can stop cleanly:

```ts
process.once("SIGTERM", () => void app.stop().finally(() => process.exit(0)));
process.once("SIGINT", () => void app.stop().finally(() => process.exit(0)));
```

## Store

The built-in SQLite store is local-first:

```ts
sqliteStore({ path: "./heypi.db" })
```

The filename is only a convention. `heypi.db`, `heypi.sqlite`, or any other SQLite filename works as long as the configured path is stable.

For multi-instance deployments, implement the exported `Store` interface with durable shared storage and `locks` for thread serialization. Custom stores should implement `transaction()` for atomic multi-table updates; nested transactions are not supported. Scheduler-capable stores must provide `jobs`, `jobRuns`, `locks`, and persist `Job.idleMs`.

SQLite stores thread routes, including the Pi `sessionId` and `sessionPath`. New threads get a random session id and a relative session path like `sessions/<session-id>.jsonl`. Relative session paths are resolved under the configured runtime root; absolute paths are also supported by the runtime adapter. Chat output and logs are redacted before user-facing delivery. SQLite stores raw audit/search/status text, while Pi session JSONL files store the canonical model transcript. Protect both the database and session files as sensitive data.

## Pi Extensions

heypi loads explicit Pi extension paths from `agent.extensions` or `agent/extensions/`. It disables Pi's default/global extension discovery so a chat agent only gets the extensions configured for that agent.

Extensions can register additional Pi tools and lifecycle hooks. Treat extension code as trusted application code: it runs in-process with access to the agent runtime. Interactive Pi extension UI and slash-command flows are not exposed as first-class chat features.

## Serverless

Cloudflare Workers and other serverless Fetch runtimes are not supported yet. The current adapters assume either a long-running process or a Node HTTP server. Serverless support is planned, but it needs a complete adapter, scheduler, storage, attachment, and deployment story before it should be used in production.

## Examples

- [`examples/slack-devops`](examples/slack-devops): Slack DevOps assistant with runbook search, local runtime tools, approval-gated SSH host tools, public-key onboarding, and file-backed host inventory.
- [`examples/telegram-workout`](examples/telegram-workout): Telegram fitness coach with onboarding, saved profile/plan, daily heartbeat check-ins, and a local workout log.

## Why heypi?

The name is a small pun: "Hey, Pi" for chat-first Pi agents, and "Hey-P-I" because this package is a TypeScript API around Pi.

## Development

```bash
pnpm install
pnpm run check
pnpm run typecheck
pnpm run test
pnpm run build
```

`pnpm run pack:dry` verifies the publishable package contents.

## License

[MIT](LICENSE)

# heypi

Chat agents on top of [Pi](https://github.com/earendil-works/pi).

heypi adds adapters, persistence, governed tools, approvals, and runtime-backed workspace access to Pi.

## Features

- Pi-backed agent loop via `@mariozechner/pi-coding-agent`
- Slack adapter with Socket Mode and HTTP receiver modes
- Telegram long-polling adapter
- SQLite store for threads, messages, turns, calls, approvals, scheduled jobs, job runs, and locks
- Pi-compatible tools: `bash`, `read`, `write`, `edit`, `grep`, `find`, `ls`, `history`
- Static runtime selection: `just-bash`, `guarded-bash`, or `host-bash`
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
			signingSecret: process.env.SLACK_SIGNING_SECRET!,
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
  SYSTEM.md
  AGENTS.md
  skills/
  extensions/
```

Missing files/folders are ignored. You can override everything in code:

```ts
agentFrom("./agent", {
	id: "devops",
	model: "openai/gpt-5-mini",
	systemPrompt: "You are a concise DevOps assistant.",
	prompt: "Prefer safe, auditable actions.",
	skills: ["./shared/skills"],
	extensions: ["./agent/extensions"],
	tools: [myTool],
});
```

Pass `model` explicitly or set `HEYPI_MODEL`. heypi does not choose a provider/model implicitly.

## Tools And Approvals

heypi exposes its own Pi-compatible tools instead of Pi's raw built-ins. `bash` can require approval through policy. File tools run inside the runtime workspace.

Add custom tools with Pi `ToolDefinition` objects or the `tool()` helper. Raw Pi tools are supported for non-confirmed tools. Use `tool()` when a custom tool needs approval so heypi can replay the call after approval:

```ts
import { Type } from "@sinclair/typebox";
import { tool } from "@hunvreus/heypi";

const pageService = tool<{ service: string; reason: string }>({
	name: "page_service",
	description: "Record a service page request.",
	parameters: Type.Object({
		service: Type.String(),
		reason: Type.String(),
	}),
	confirm: ({ service }) => ({ reason: `Page ${service}` }),
	execute: async ({ service, reason }) => `page recorded: service=${service} reason=${reason}`,
});
```

Text fallback for approvals works on every adapter:

```text
approve <approval-id>
deny <approval-id>
status
status <call-id>
cancel <turn-id-or-trace>
```

Slack and Telegram also render provider-native buttons.

## Adapters

Slack and Telegram adapters both handle inbound messages, provider-native approval buttons, progress updates, and outbound attachments.

### Slack

Slack supports Socket Mode for local development:

```ts
slack({
	botToken: process.env.SLACK_BOT_TOKEN!,
	signingSecret: process.env.SLACK_SIGNING_SECRET!,
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
	progress: { reaction: "eyes", message: "Thinking..." },
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

All Slack modes use the same bot token, signing secret, message handling, approvals, and reply behavior. HTTP mode starts Bolt's built-in Node HTTP receiver.

See [`docs/SLACK.md`](docs/SLACK.md) for scopes, events, manifests, and common setup failures.

Inbound Slack messages can be restricted with `allow`. Omitted `teams`, `channels`, and `users` allow all delivered events for that dimension. `channels` applies to non-DM channels only. `allow.dms` defaults to `true`. `trigger` defaults to `"mention"` for channels; accepted DMs always trigger.

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
	progress: { message: "Thinking..." },
});
```

See [`docs/TELEGRAM.md`](docs/TELEGRAM.md) for BotFather setup and chat discovery.

Inbound Telegram messages can be restricted with `allow`. Omitted `chats` and `users` allow all delivered updates for that dimension. `chats` applies to groups/channels only. `allow.dms` defaults to `true`. `trigger` defaults to `"mention"` for groups; accepted private chats always trigger.

Streaming is opt-in. Use `streaming: true` for the defaults, or pass `{ intervalMs, minChars, maxFailures }` to tune it. When enabled, heypi posts a draft reply and edits it at a bounded cadence while Pi emits text deltas. Confirmed tool calls stop the draft stream before approval buttons are sent; after approval, continuation can start a new draft stream. Progress messages are suppressed while streaming is active to avoid duplicate visible replies.

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
	start(input: { handler: Handler; logger: Logger; attachments?: AttachmentStore }): Promise<void>;
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
pnpm exec heypi jobs list --db examples/telegram-workout/heypi.db
```

The CLI is not used by `createHeypi()` at runtime. See [`docs/CLI.md`](docs/CLI.md).

## Runtime

Runtime selection is static per app.

```ts
runtime: {
	name: "just-bash", // "guarded-bash" | "host-bash"
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
		python: false,
		javascript: false,
	},
	hostEnv: {
		CI: "true",
	},
}
```

`just-bash` is the default production runtime. `guarded-bash` and `host-bash` execute host bash from the configured workspace root; they are not OS isolation. Host runtimes receive a minimal environment by default; pass `hostEnv` to expose specific variables.

Regex command policy is a guardrail, not a sandbox. Use `just-bash` for team-facing agents.

Runtime file tools enforce size limits by default: 1 MB per file, 5 MB per scan, and 10,000 traversed entries. Override `runtime.limits` for larger workspaces.

Attachments are limited to 25 MB by default. Override with `attachment: { maxBytes }`, or pass a custom `attachments` store.

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

For multi-instance deployments, implement the exported `Store` interface with durable shared storage and `locks` for thread serialization. Custom stores should implement `transaction()` for atomic multi-table updates; nested transactions are not supported. Scheduler-capable stores must provide `jobs`, `jobRuns`, `locks`, and persist `Job.idleMs`.

Chat output and logs are redacted before user-facing delivery, but the SQLite transcript stores raw model/tool text for audit and replay fidelity. Protect the database as sensitive data.

## Serverless

Cloudflare Workers and other serverless Fetch runtimes are not supported yet. The current adapters assume either a long-running process or a Node HTTP server. Serverless support is planned, but it needs a complete adapter, scheduler, storage, attachment, and deployment story before it should be used in production.

## Examples

- [`examples/slack-devops`](examples/slack-devops): Slack DevOps assistant with runbook search, governed bash, approvals, and a confirmed custom paging tool.
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

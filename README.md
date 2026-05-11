# heypi

Chat agents on top of [Pi](https://github.com/earendil-works/pi).

heypi adds adapters, persistence, governed tools, approvals, and runtime-backed workspace access to Pi.

## Features

- Pi-backed agent loop via `@mariozechner/pi-coding-agent`
- Slack adapter with Socket Mode and HTTP receiver modes
- Telegram long-polling adapter
- SQLite store for threads, messages, turns, calls, approvals, and locks
- Pi-compatible tools: `bash`, `read`, `write`, `edit`, `grep`, `find`, `ls`, `history`
- Static runtime selection: `just-bash`, `guarded-bash`, or `host-bash`
- Human approval flow for tool calls that require confirmation
- Runtime-backed attachment handling
- JSON or pretty console logging

## Install

```bash
npm install heypi
```

## Minimal App

```ts
import { agentFrom, createHeypi, slack, sqliteStore, workspace } from "heypi";

const app = createHeypi({
	store: sqliteStore({ path: "./heypi.db" }),
	adapters: [
		slack({
			botToken: process.env.SLACK_BOT_TOKEN!,
			signingSecret: process.env.SLACK_SIGNING_SECRET!,
			mode: "socket",
			appToken: process.env.SLACK_APP_TOKEN!,
			reply: "thread",
		}),
	],
	agent: agentFrom("./agent", { model: "openai/gpt-5-mini" }),
	runtime: {
		name: "just-bash",
		root: workspace("./workspace"),
	},
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

## Tools And Approvals

heypi exposes its own Pi-compatible tools instead of Pi's raw built-ins. `bash` can require approval through policy. File tools run inside the runtime workspace.

Add custom tools with Pi `ToolDefinition` objects or the `tool()` helper. Raw Pi tools are supported for non-confirmed tools. Use `tool()` when a custom tool needs approval so heypi can replay the call after approval:

```ts
import { Type } from "@sinclair/typebox";
import { tool } from "heypi";

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
	reply: "thread",
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
	reply: "thread",
});
```

In Slack app settings:

- Socket Mode: enable Socket Mode and create an app-level token with `connections:write`.
- HTTP mode: set Event Subscriptions and Interactivity URLs to `https://<host>/slack/events`, or to the custom `path` you configured.

Both modes use the same bot token, signing secret, message handling, approvals, and reply behavior. HTTP mode starts Bolt's built-in HTTP receiver; serverless/external request handlers are not included yet.

### Telegram

Telegram uses long polling:

```ts
telegram({
	token: process.env.TELEGRAM_BOT_TOKEN!,
	progress: { message: "Thinking..." },
});
```

Custom adapters implement:

```ts
type Adapter = {
	start(input: { handler: Handler; logger: Logger; attachments?: AttachmentStore }): Promise<void>;
	stop?(): Promise<void>;
};
```

## Runtime

Runtime selection is static per app.

```ts
runtime: {
	name: "just-bash", // "guarded-bash" | "host-bash"
	root: workspace("./workspace"),
	maxConcurrent: 12,
	maxConcurrentPerChat: 1,
	timeoutMs: 120_000,
	justBash: {
		python: false,
		javascript: false,
	},
}
```

`just-bash` is the default low-overhead runtime. `guarded-bash` and `host-bash` execute host bash from the configured workspace root; they are not OS isolation.

## Store

The built-in SQLite store is local-first:

```ts
sqliteStore({ path: "./heypi.db" })
```

For multi-instance deployments, implement the exported `Store` interface with durable shared storage and `locks` for thread serialization.

## Examples

- [`examples/slack-devops`](examples/slack-devops): Slack DevOps assistant with runbook search, governed bash, approvals, and a confirmed custom paging tool.
- [`examples/telegram-workout`](examples/telegram-workout): Telegram workout accountability bot with daily/weekly skills and a local workout log.

## Development

```bash
pnpm install
pnpm run check
pnpm run typecheck
pnpm run test
pnpm run build
```

`npm pack --dry-run` verifies the publishable package contents.

## License

[MIT](LICENSE)

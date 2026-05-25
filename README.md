<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/heypi-white.png">
    <source media="(prefers-color-scheme: light)" srcset="docs/assets/heypi-black.png">
    <img alt="heypi" src="docs/assets/heypi-black.png" width="320">
  </picture>
</p>

# heypi

Chat agents for your team, with approvals and sandboxed tools. Slack, Discord, Telegram, webhooks.

heypi gives [Pi](https://github.com/earendil-works/pi) a production chat shell: persisted threads, runtime-backed tools, human approval flows, scheduled turns, and attachment handling.

## Install

```bash
npm install @hunvreus/heypi
```

## Quickstart

```ts
import { agentFrom, createHeypi, runHeypi, slack, workspace } from "@hunvreus/heypi";

const app = createHeypi({
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
	approval: {
		approvers: ["U123456"],
	},
});

await runHeypi(app);
```

`OPENAI_API_KEY` is read by Pi through its normal provider auth path. Pass `model` explicitly or set `HEYPI_MODEL`; heypi does not pick a model implicitly. `runHeypi(app)` starts the app and stops it cleanly on `SIGINT`/`SIGTERM`.

## Agent Folder

`agentFrom("./agent")` loads this convention:

```text
agent/
  SOUL.md
  AGENTS.md
  SYSTEM.md
  skills/
  extensions/
```

- `SOUL.md`: identity, role, and voice. Missing file falls back to a concise assistant identity.
- `AGENTS.md`: operating rules and standing instructions.
- `SYSTEM.md`: advanced full runtime-prompt override. Most agents should not need it.
- `skills/` and `extensions/`: extra Pi skills/extensions for this agent only.

You can also configure the agent in code:

```ts
agentFrom("./agent", {
	id: "devops",
	model: "openai/gpt-5-mini",
	soul: "You are a concise DevOps assistant.",
	prompt: "Prefer safe, auditable actions.",
	context: [
		async ({ provider, channel, actorName }) => ({
			title: "Current chat",
			text: [`Provider: ${provider}`, `Channel: ${channel}`, actorName ? `Sender: ${actorName}` : undefined]
				.filter(Boolean)
				.join("\n"),
		}),
	],
});
```

Use `context` for short dynamic facts such as tenant metadata, current host inventory, or channel policy. heypi already injects basic provider/channel/thread/sender context.

## Tools And Approvals

By default, heypi exposes Pi-compatible tools for shell, files, search, and history:

```text
bash, read, write, edit, grep, find, ls, history
```

`bash` uses confirmation by default. File/search tools run without approval unless you configure them differently.

```ts
import { agentFrom, commandConfirm, coreTools } from "@hunvreus/heypi";

agentFrom("./agent", {
	model: "openai/gpt-5-mini",
	tools: [
		...coreTools({
			bash: {
				confirm: commandConfirm({
					allow: [/^curl -I https:\/\/status\.example\.com\b/],
					approve: [/\bmake deploy\b/],
					block: [/\bgh repo delete\b/],
				}),
			},
			write: false,
			edit: false,
		}),
		myTool,
	],
});
```

Add confirmed custom tools with `tool()` so heypi can pause for approval and replay the call safely:

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
	confirm: ({ service, reason }) => ({
		message: "Page service.",
		details: [
			{ label: "Service", value: service },
			{ label: "Reason", value: reason },
		],
	}),
	execute: async ({ service, reason }) => `page recorded: service=${service} reason=${reason}`,
});
```

Slack, Telegram, and Discord also render provider-native approval buttons. Approvals are in-place; long approved calls continue as normal progress/results.

Chat commands and permission defaults are covered in [`docs/CHAT.md`](docs/CHAT.md).
See [`docs/EXTENDING.md`](docs/EXTENDING.md) for custom tools, command risk classification, and advanced confirmation rules.

## Adapters

heypi ships built-in adapters for Slack, Telegram, Discord, and webhooks.

```ts
import { discord, slack, telegram, webhook } from "@hunvreus/heypi";
```

Slack, Telegram, and Discord share access defaults, streaming, approvals, cancel, and busy-thread behavior. See [`docs/CHAT.md`](docs/CHAT.md).

Setup docs:

- [`docs/CHAT.md`](docs/CHAT.md)
- [`docs/SLACK.md`](docs/SLACK.md)
- [`docs/TELEGRAM.md`](docs/TELEGRAM.md)
- [`docs/DISCORD.md`](docs/DISCORD.md)
- [`docs/WEBHOOK.md`](docs/WEBHOOK.md)

Example adapter configs:

```ts
slack({
	botToken: process.env.SLACK_BOT_TOKEN!,
	mode: "socket",
	appToken: process.env.SLACK_APP_TOKEN!,
	allow: { channels: ["C123"] },
	trigger: "mention",
	reply: "thread",
	streaming: true,
});

webhook({
	secret: process.env.HEYPI_WEBHOOK_SECRET!,
	port: 3000,
	host: "127.0.0.1",
	path: "/webhook",
	replyHosts: ["internal.example.com"],
});
```

Slack is the representative chat-adapter example here. Telegram and Discord use the same `allow`, `trigger`, and `streaming` shape; their setup docs cover provider-specific IDs and tokens.

## Streaming And Busy Threads

Configure streaming on each adapter and busy-thread behavior at the app level. See [`docs/CHAT.md`](docs/CHAT.md) for behavior; the global busy-thread copy is configurable:

```ts
createHeypi({
	// ...
	concurrency: {
		busy: "steer", // "steer" | "followUp" | "reject"
		messages: {
			busySteer: "Got it. I'll include that.",
			busyFollowUp: "Got it. I'll handle that next.",
			busyReject: "I'm still working on the previous message. Send this again after I reply, or use `cancel`.",
			pendingApprovalReject: "I'm waiting for the pending approval first.",
		},
	},
});
```

## Scheduling

heypi can create proactive turns:

- `cron`: run at a wall-clock schedule.
- `heartbeat`: run over known chats after a schedule and optional idle window.

```ts
jobs: [
	{
		id: "daily-checkin",
		kind: "heartbeat",
		everyMs: 24 * 60 * 60 * 1000,
		scope: { adapters: ["telegram"] },
		prompt: "Check whether this chat needs follow-up.",
	},
];
```

See [`docs/SCHEDULING.md`](docs/SCHEDULING.md).

## Runtime And Attachments

Use one runtime per app. `just-bash` is the recommended default.

```ts
runtime: {
	name: "just-bash", // "docker-bash" | "guarded-bash" | "host-bash"
	root: workspace("./workspace"),
}
```

`just-bash` disables network by default. `docker-bash` gives OS-level process isolation through Docker. `guarded-bash` and `host-bash` run on the host and should be used only for trusted deployments.

Attachments are stored under the runtime root. Text-like files are inlined into the prompt, images are passed to Pi as image inputs, and unsupported binaries are kept as references. Optional PDF/Office conversion is available with:

```ts
attachments: { process: { documents: true } }
```

The bundled `heypi-convert-document` wrapper uses Microsoft MarkItDown. If document conversion is enabled, prewarm it during deploy:

```bash
heypi-convert-document --setup
```

See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for runtime boundaries, shutdown, and security notes.

## Store

By default, `createHeypi()` uses SQLite at `./heypi.db`.

Pass `store` when you need a different path or custom store:

```ts
import { sqliteStore } from "@hunvreus/heypi";

store: sqliteStore({ path: "./heypi.db" })
```

Treat the database and Pi session files as sensitive data. Run migrations with:

```bash
heypi db migrate --db ./heypi.db
```

Custom stores are advanced. See [`docs/EXTENDING.md`](docs/EXTENDING.md).

## CLI

The `heypi` CLI is for setup checks, diagnostics, migrations, and job inspection. It is not used by `createHeypi()` at runtime.

```bash
heypi check --env .env --db ./heypi.db
heypi slack check --env .env
heypi telegram observe --env .env
heypi discord observe --env .env
heypi approvals list --db ./heypi.db
heypi jobs list --db ./heypi.db
```

See [`docs/CLI.md`](docs/CLI.md).

## More Docs

- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md): process model, persistence, security model
- [`docs/CHAT.md`](docs/CHAT.md): shared chat defaults, streaming, approvals, cancel
- [`docs/EXTENDING.md`](docs/EXTENDING.md): custom tools, adapters, stores, attachments
- [`docs/SCHEDULING.md`](docs/SCHEDULING.md): cron and heartbeat jobs
- [`docs/CLI.md`](docs/CLI.md): setup and diagnostic commands

## Examples

- [`examples/slack-devops`](examples/slack-devops): Slack DevOps assistant with runbook search, approvals, SSH host tools, and host inventory.
- [`examples/discord-project`](examples/discord-project): Discord project assistant with streaming, approvals, and simple project-state tools.
- [`examples/telegram-workout`](examples/telegram-workout): Telegram fitness coach with onboarding, saved profile/plan, daily heartbeat check-ins, and a local workout log.
- [`examples/webhook-notes`](examples/webhook-notes): tiny webhook note-taking agent with curl examples.

## Development

```bash
pnpm install
pnpm run check
pnpm run typecheck
pnpm run test
pnpm run build
pnpm run pack:dry
```

## License

[MIT](LICENSE)

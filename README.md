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
- [`docs/ADMIN.md`](docs/ADMIN.md)

Example adapter configs:

```ts
createHeypi({
	http: { host: "127.0.0.1", port: 3000 },
	adapters: [
		slack({
			botToken: process.env.SLACK_BOT_TOKEN!,
			mode: "socket",
			appToken: process.env.SLACK_APP_TOKEN!,
			allow: { channels: ["C123"] },
			trigger: "mention",
			reply: "thread",
			streaming: true,
		}),
		webhook({
			name: "internal",
			secret: process.env.HEYPI_WEBHOOK_SECRET!,
			replyHosts: ["internal.example.com"],
		}),
	],
});
```

Slack is the representative chat-adapter example here. Telegram and Discord use the same `allow`, `trigger`, and `streaming` shape; their setup docs cover provider-specific IDs and tokens.

## Streaming And Busy Threads

Configure streaming on each adapter and busy-thread behavior at the app level. See [`docs/CHAT.md`](docs/CHAT.md) for behavior and the full system-message list:

```ts
createHeypi({
	// ...
	chat: {
		busy: "steer", // "steer" | "followUp" | "reject"
	},
	messages: {
		busySteer: "Got it. I'll include that.",
		busyFollowUp: "Got it. I'll handle that next.",
		busyReject: "I'm still working on the previous message. Send this again after I reply, or use `cancel`.",
		pendingApprovalReject: "I'm waiting for the pending approval first.",
		approvalUnavailable: "That approval is no longer available.",
	},
});
```

## Scope And Memory

`scope` controls how broadly the tool workspace, generated files, and attachments are shared:

- `channel` default: one workspace per Slack channel, Telegram chat, Discord channel, or webhook channel.
- `user`: one workspace per chat user.
- `adapter`: one workspace for an adapter instance.
- `agent`: one workspace across adapters for this configured agent.

Pi sessions and chat history stay per thread.

Memory is off by default. When enabled, `memory.scope` controls who shares the memory file and defaults to the top-level `scope`:

```ts
createHeypi({
	// ...
	scope: "channel",
	memory: {
		enabled: true,
		scope: "user",
		writePolicy: "approvers",
		maxChars: 4000,
	},
});
```

Memory scopes are `channel`, `user`, `adapter`, or `agent`. `writePolicy` controls memory mutation:

- `auto`: the agent can write, replace, and delete memory.
- `approvers`: only turns initiated by `approval.approvers` can mutate memory.
- `off`: memory is read/injected, but mutation is disabled.

When `approval.approvers` is configured, writes default to `approvers`. Without approvers, `channel` and `user` default to `auto`; `adapter` and `agent` default to `off`. Enabled memory logs its scope and write policy at startup, with broad scopes logged as warnings. Memory is shared durable model context, not trusted config: anyone allowed by the write policy can affect future answers in that scope.

See [`docs/SCOPE_AND_MEMORY.md`](docs/SCOPE_AND_MEMORY.md).

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
		scope: { telegram: {} },
		prompt: "Check whether this chat needs follow-up.",
	},
];
```

See [`docs/SCHEDULING.md`](docs/SCHEDULING.md).

## Runtime And Attachments

Use one runtime config per app. `just-bash` is the recommended default.

```ts
runtime: {
	name: "just-bash", // "docker-bash" | "guarded-bash" | "host-bash"
	root: workspace("./workspace"),
}
```

`just-bash` disables network by default. `docker-bash` gives OS-level process isolation through Docker. `guarded-bash` and `host-bash` run on the host and should be used only for trusted deployments.

Tool workspaces are derived from the configured `scope`. Inbound attachments use a separate scoped attachment tree, and outbound generated files resolve from the active scoped workspace, so files from one channel are not resolved from another channel under the default scope. Text-like files are inlined into the prompt, images are passed to Pi as image inputs, and unsupported binaries are kept as references. Optional PDF/Office conversion is available with:

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
heypi check --db ./heypi.db
heypi slack check
heypi slack channels
heypi telegram observe
heypi discord observe
heypi admin link
heypi approvals list --db ./heypi.db
heypi jobs list --db ./heypi.db --agent slack-devops
```

The CLI loads `./.env` by default when it exists. Pass `--env <path>` to use a different env file.

See [`docs/CLI.md`](docs/CLI.md).

## More Docs

- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md): process model, persistence, security model
- [`docs/CHAT.md`](docs/CHAT.md): shared chat defaults, streaming, approvals, cancel
- [`docs/SCOPE_AND_MEMORY.md`](docs/SCOPE_AND_MEMORY.md): scope and memory model
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

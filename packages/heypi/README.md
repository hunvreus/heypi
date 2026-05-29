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

## Contents

- [Install](#install)
- [Quickstart](#quickstart)
- [Agent Folder](#agent-folder)
- [Tools And Approvals](#tools-and-approvals)
- [Adapters](#adapters)
- [Runtime And Attachments](#runtime-and-attachments)
- [Scope And Memory](#scope-and-memory)
- [Scheduling](#scheduling)
- [Store](#store)
- [CLI](#cli)
- [More Docs](#more-docs)
- [Examples](#examples)

## Install

Requirements:

- Node.js 22 or newer.
- Optional for document conversion (e.g. PDF): Python 3 plus `uv`, or Python 3 with MarkItDown already installed.

```bash
npm install @hunvreus/heypi
```

## Quickstart

```ts
import { agentFrom, createHeypi, runHeypi, slack, workspace } from "@hunvreus/heypi";

const app = createHeypi({
	state: { root: "./state" },
	adapters: [
		slack({
			botToken: process.env.SLACK_BOT_TOKEN!,
			appToken: process.env.SLACK_APP_TOKEN!,
		}),
	],
	agent: agentFrom("./agent", { model: "openai/gpt-5-mini" }),
	runtime: { root: workspace("./workspace") },
});

await runHeypi(app);
```

`OPENAI_API_KEY` is read by Pi through its normal provider auth path. Pass `model` explicitly or set `HEYPI_MODEL`; heypi does not pick a model implicitly. `runHeypi(app)` starts the app and stops it cleanly on `SIGINT`/`SIGTERM`.

For production, add `allow`, `approval.approvers`, and explicit runtime/network policy.

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

Custom tool code runs as trusted host-side JavaScript. When a tool needs sandboxed command or file work, use the selected runtime from the execution context:

```ts
const inspect = tool({
	name: "inspect",
	description: "Inspect the runtime workspace.",
	parameters: Type.Object({}),
	execute: async (_params, ctx) => {
		const result = await ctx.runtime.bash?.({ command: "pwd && ls", signal: ctx.signal });
		return result?.out ?? "runtime does not support bash";
	},
});
```

`ctx.runtime` is the raw selected runtime for that turn. Calls made through it are covered by the custom tool's own `confirm` decision, but they do not create separate nested approval records.

Slack, Telegram, and Discord also render provider-native approval buttons. Approvals are in-place; long approved calls continue as normal progress/results.

Chat commands and permission defaults are covered in [`docs/CHAT.md`](docs/CHAT.md).
See [`docs/EXTENDING.md`](docs/EXTENDING.md) for custom tools, command risk classification, and advanced confirmation rules.

## Adapters

heypi ships built-in adapters for Slack, Telegram, Discord, and webhooks.

```ts
import { discord, slack, telegram, webhook } from "@hunvreus/heypi";
```

Slack, Telegram, and Discord share access defaults, streaming, approvals, cancel, and busy-thread behavior. See [`docs/CHAT.md`](docs/CHAT.md).

Guides:

- [`docs/CHAT.md`](docs/CHAT.md): chat behavior
- [`docs/SLACK.md`](docs/SLACK.md): Slack
- [`docs/TELEGRAM.md`](docs/TELEGRAM.md): Telegram
- [`docs/DISCORD.md`](docs/DISCORD.md): Discord
- [`docs/WEBHOOK.md`](docs/WEBHOOK.md): webhooks
- [`docs/ADMIN.md`](docs/ADMIN.md): admin UI

Example adapter configs:

```ts
createHeypi({
	state: { root: "./state" },
	http: { host: "127.0.0.1", port: 3000 },
	adapters: [
		slack({
			botToken: process.env.SLACK_BOT_TOKEN!,
			appToken: process.env.SLACK_APP_TOKEN!,
			allow: { channels: ["C123"] },
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

Slack is the representative chat-adapter example here. Telegram and Discord use the same `allow` and `streaming` shape; their setup docs cover provider-specific IDs, tokens, and trigger options.

Custom adapter packages can implement the `Adapter` interface from `@hunvreus/heypi/adapter` and pass the result to `createHeypi({ adapters })`. The built-in adapters are concrete provider integrations, not subclassable bases.

## Streaming And Busy Threads

Configure streaming on each adapter and override busy-thread behavior at the app level when the default `steer` behavior is not right. See [`docs/CHAT.md`](docs/CHAT.md) for behavior and the full system-message list:

```ts
createHeypi({
	state: { root: "./state" },
	// ...adapters, agent, runtime
	chat: {
		busy: "followUp", // default: "steer"; also supports "reject"
	},
	messages: {
		busySteer: "Got it. I'll include that.",
		busyFollowUp: "Got it. I'll handle that next.",
		busyReject: "I'm still working on the previous message. Send this again after I reply, or use `cancel`.",
		pendingApprovalReject: "I'm waiting for the pending approval first.",
		approvalUnavailable: "That approval is no longer available.",
		runtimeStarting: "Preparing runtime...",
		runtimeFailed: "Runtime failed. Ask an admin to check the server logs.",
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
	state: { root: "./state" },
	// ...adapters, agent, runtime
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

Use one runtime config per app. The runtime is heypi's command/file/search API for core tools and for custom tools that explicitly call `ctx.runtime`. `just-bash` is built in and is the default.

```ts
runtime: {
	root: workspace("./workspace"),
	// scope: "user", // optional override; defaults to top-level scope
}
```

Set `runtime.name` only when choosing another built-in runtime. `guarded-bash` and `host-bash` run on the host and should be used only for trusted deployments.

Network defaults are runtime-specific:

- `just-bash`: network is disabled by default; enable `runtime.justBash.network` only for the URLs the agent needs.
- `@hunvreus/heypi-runtime-docker`: Docker network defaults to `none`; set `network: "bridge"` or another Docker network explicitly.
- `@hunvreus/heypi-runtime-gondolin`: VM egress is open by default; use Gondolin secret host restrictions for sensitive outbound credentials.

Experimental runtime provider packages live outside the core package:

```bash
npm install @hunvreus/heypi-runtime-docker
npm install @hunvreus/heypi-runtime-gondolin
```

```ts
import { dockerRuntime } from "@hunvreus/heypi-runtime-docker";
import { gondolinRuntime } from "@hunvreus/heypi-runtime-gondolin";

runtime: {
	root: workspace("./workspace"),
	provider: dockerRuntime({ image: "debian:bookworm-slim" }),
	// provider: gondolinRuntime(),
}
```

Provider packages can keep one warm container or VM per runtime scope. Docker and Gondolin implement the same runtime API as built-in runtimes, so core `bash`, file, and search tools execute through the selected sandbox. These provider packages are usable for local testing and early adopters, but their APIs and operational behavior may change before heypi 1.0.

Provider-specific install steps and system prerequisites live with each package:

- [`@hunvreus/heypi-runtime-docker`](https://www.npmjs.com/package/@hunvreus/heypi-runtime-docker): experimental preview; requires Docker CLI and a running Docker daemon.
- [`@hunvreus/heypi-runtime-gondolin`](https://www.npmjs.com/package/@hunvreus/heypi-runtime-gondolin): experimental preview; requires Node.js 23.6+ and QEMU for Gondolin's VM backend.

Tool workspaces inherit the top-level `scope` by default; `runtime.scope` can override that sharing policy independently from memory. Inbound attachments use a separate scoped attachment tree, and outbound generated files resolve from the active scoped workspace, so files from one channel are not resolved from another channel under the default scope. Text-like files are inlined into the prompt, images are passed to Pi as image inputs, and unsupported binaries are kept as references. Optional PDF/Office conversion is available with:

```ts
attachments: { process: { documents: true } }
```

The bundled `heypi-convert-document` wrapper uses Microsoft MarkItDown through Python. If you rely on `uv` to provision MarkItDown, prewarm it during deploy:

```bash
heypi-convert-document --setup
```

See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for runtime boundaries, shutdown, and security notes.

## Store

`createHeypi()` requires an explicit `state.root`. Generated local state, admin signing material, and the default SQLite database live under that directory.

When `store` is omitted, heypi uses SQLite at `<state.root>/heypi.db`:

```ts
createHeypi({
	state: { root: "./state" },
	// ...
});
```

Pass `store` only when you need a custom database path or custom store. Treat the database, admin secret, and Pi session files as sensitive data. Run migrations with:

```bash
heypi db migrate --db ./state/heypi.db
```

Custom stores and other extension contracts are advanced and use explicit subpaths such as `@hunvreus/heypi/store`. See [`docs/EXTENDING.md`](docs/EXTENDING.md).

## CLI

The `heypi` CLI is for setup checks, diagnostics, migrations, and job inspection. It is not used by `createHeypi()` at runtime.

```bash
heypi check --db ./state/heypi.db
heypi slack check
heypi slack channels
heypi telegram observe
heypi discord observe
heypi admin link
heypi approvals list --db ./state/heypi.db
heypi jobs list --db ./state/heypi.db --agent slack-devops
```

The CLI loads `./.env` by default when it exists. Pass `--env <path>` to use a different env file.

See [`docs/CLI.md`](docs/CLI.md).

## More Docs

- [`docs/CHAT.md`](docs/CHAT.md): shared Slack, Telegram, and Discord behavior
- [`docs/SLACK.md`](docs/SLACK.md): Slack setup
- [`docs/TELEGRAM.md`](docs/TELEGRAM.md): Telegram setup
- [`docs/DISCORD.md`](docs/DISCORD.md): Discord setup
- [`docs/WEBHOOK.md`](docs/WEBHOOK.md): webhook HTTP API
- [`docs/SCOPE_AND_MEMORY.md`](docs/SCOPE_AND_MEMORY.md): scope and memory model
- [`docs/SCHEDULING.md`](docs/SCHEDULING.md): cron and heartbeat jobs
- [`docs/CLI.md`](docs/CLI.md): setup and diagnostic commands
- [`docs/ADMIN.md`](docs/ADMIN.md): local admin panel
- [`docs/EXTENDING.md`](docs/EXTENDING.md): custom tools, adapters, stores, attachments
- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md): maintainer internals

## Examples

- [`examples/slack-devops`](https://github.com/hunvreus/heypi/tree/main/examples/slack-devops): Slack DevOps assistant with runtime tools, runbook search, approvals, SSH host tools, and host inventory.
- [`examples/discord-project`](https://github.com/hunvreus/heypi/tree/main/examples/discord-project): Discord project assistant with streaming, approvals, and simple project-state tools.
- [`examples/telegram-workout`](https://github.com/hunvreus/heypi/tree/main/examples/telegram-workout): Telegram fitness coach with onboarding, saved profile/plan, daily heartbeat check-ins, and a local workout log.
- [`examples/webhook-notes`](https://github.com/hunvreus/heypi/tree/main/examples/webhook-notes): tiny webhook note-taking agent with curl examples.

## License

[MIT](LICENSE)

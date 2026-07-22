# Introduction

heypi is a TypeScript framework for running a shared [Pi](https://pi.dev) agent in Slack,
Discord, Telegram, local applications, or trusted webhook workflows.

## Why heypi?

[OpenClaw](https://openclaw.ai/) introduced two useful ideas:

- **Local first**: run close to the user's tools, files, CLIs, browser sessions, and credentials
  instead of rebuilding every integration as a hosted connector.
- **Capabilities over workflows**: give the agent instructions, skills, and tools, then let the model
  decide how to use them instead of forcing each task into a predefined workflow.

That model becomes more difficult when an agent is shared by a team. heypi adds the missing
boundaries:

- **Conversation identity**: keep DMs, channel conversations, native threads, and reply chains
  separate while preserving useful continuity.
- **Approvals**: require specific users or groups to approve sensitive tool calls.
- **Runtime isolation**: execute commands through host, Docker, Gondolin, just-bash, Vercel
  Sandbox, Cloudflare Sandbox, or a custom runtime.
- **Accountability**: retain conversation events, approvals, schedule runs, and Pi session
  transcripts on infrastructure you control.

For example, [Codex Tag](https://github.com/hunvreus/heypi/tree/main/examples/codex-tag) turns Pi
into a shared coding agent. A teammate can mention it with an issue or repository, steer the active
turn, approve sensitive actions, and receive the result in the same conversation.

## How it works

Pi remains the agent runtime. It owns model execution, sessions, transcripts, compaction, retries,
tools, and extensions. heypi adds the team-facing layer around it:

- Adapters translate Slack, Discord, Telegram, local, and webhook events into one conversation
  model.
- Agent folders provide instructions, tools, skills, schedules, and other staged resources.
- Runtime providers expose model-visible `/workspace`, `/shared`, and `/agent` roots without leaking
  host paths.
- Approval policies gate sensitive tool calls before execution.
- Small append-only records coordinate queues, approvals, schedules, cancellation, and recovery.

Configuration stays in code:

```ts
import { host, loadAgent, modelFromEnv, runHeypi, slack } from "@hunvreus/heypi";

const agent = loadAgent("./agent", {
	model: modelFromEnv(),
	runtime: host({ workspace: "./workspace" }),
});

await runHeypi(agent, [
	slack({
		token: process.env.SLACK_BOT_TOKEN!,
		appToken: process.env.SLACK_APP_TOKEN!,
	}),
]);
```

heypi is not a workflow builder or a second model runtime. It keeps the coordination layer small
and delegates agent behavior to Pi.

## Project layout

A small heypi app is just files:

```text
my-agent/
├── index.ts
├── .env
└── agent/
    ├── instructions.md
    ├── system.md
    ├── tools/
    ├── skills/
    ├── extensions/
    └── schedules/
```

- `index.ts` wires the agent, runtime, state, and adapters.
- `agent/instructions.md` defines stable agent behavior.
- `agent/system.md` is optional low-level system context.
- `agent/tools/` and `agent/extensions/` hold Pi-native authored capabilities.
- `agent/skills/` holds procedures Pi loads when relevant.
- `agent/schedules/` holds trusted cron modules loaded by heypi.

Start with the generated app. Add folders only when the agent needs that capability.

## Get started

Follow the [quickstart](getting-started/index.md) to create a Codex Tag agent, then read the
[configuration](configuration/index.md) and [adapters](adapters/index.md) docs.

## How can I help?

heypi is free and open source:

- [Star it on GitHub](https://github.com/hunvreus/heypi)
- [Report bugs or request features](https://github.com/hunvreus/heypi/issues)
- [Submit a pull request](https://github.com/hunvreus/heypi/pulls)
- [Sponsor the project](https://github.com/sponsors/hunvreus)

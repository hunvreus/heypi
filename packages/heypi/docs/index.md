# Introduction

heypi is a TypeScript framework for governed AI agents in team chat. It runs [Pi](https://pi.dev) agents in Slack, Discord, Telegram, and trusted webhook entrypoints, with approvals, audit trails, scoped runtime tools, memory, secret handoff, scheduling, and an admin panel.

The core product focus is chat-ops: give an agent useful access to your team's tools while keeping sensitive actions reviewable and visible.

## What heypi is for

- Shared agents that work in team channels instead of one user's local terminal.
- Operations, support, project, and internal tooling agents that need trusted TypeScript tools or shell/file access.
- Use cases where approvals, bypasses, tool calls, failures, and chat context need an audit trail.
- Long-running Node.js services owned by your team, with persistent SQLite state and workspace files.

## What heypi is not

heypi is not a serverless workflow platform or durable replay engine. It records interrupted work during startup recovery, but it does not replay arbitrary in-flight agent turns after a process crash. For production, run one supervised heypi process per app/store and keep `state` and `workspace` on persistent storage.

## How it works

- Add adapters for [Slack](adapters/slack.md), [Discord](adapters/discord.md), [Telegram](adapters/telegram.md), or [webhooks](adapters/webhook.md).
- Load an agent from `agent/instructions.md`, [tools](configuration/tools.md), [skills](configuration/skills.md), jobs, and optional extensions.
- Persist discussions, actors, turns, calls, approvals, bypasses, memory, and jobs in SQLite.
- Run command, file, search, and attachment tools through scoped runtimes such as just-bash, Docker, Gondolin, or a custom provider.
- Enforce approval rules before sensitive tools continue, then expose the trace in chat and admin.

For example, the [Slack DevOps agent example](https://github.com/hunvreus/heypi/tree/main/examples/slack-devops) gives an AI agent access to servers through host tools. A safe request, such as "What is the load on db-1?", can run without approval. A risky request, such as running a database migration, can require approval from a specific user or group.

Read more in the [configuration guide](configuration/index.md).

## Get started

Follow the [quickstart](quickstart/index.md) to run a minimal Slack bot, then read [configuration](configuration/index.md) for the main app-level knobs. You can also try one of the examples:

- [`slack-devops`](https://github.com/hunvreus/heypi/tree/main/examples/slack-devops): Slack operations agent with SSH host tools, approvals, memory, secrets, and runbooks.
- [`discord-gondolin`](https://github.com/hunvreus/heypi/tree/main/examples/discord-gondolin): Discord project assistant with Gondolin runtime, channel scope, skills, secrets, and generated-file attachments.
- [`telegram-workout`](https://github.com/hunvreus/heypi/tree/main/examples/telegram-workout): Telegram fitness coach with scoped memory and scheduled check-ins.
- [`webhook-github-docker`](https://github.com/hunvreus/heypi/tree/main/examples/webhook-github-docker): Webhook automation that investigates GitHub issues in Docker and comments back through trusted tools.

## How can I help?

heypi is 100% free and open source:

- [Star it on GitHub](https://github.com/hunvreus/heypi)
- [Report bugs or request features](https://github.com/hunvreus/heypi/issues)
- [Submit a pull request](https://github.com/hunvreus/heypi/pulls)
- [Sponsor the project](https://github.com/sponsors/hunvreus)

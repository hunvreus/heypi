# Introduction

heypi is a TypeScript framework to build AI chat agents for your team on Slack, Discord, Telegram, or via webhooks.

## Why heypi?

[OpenClaw](https://openclaw.ai/) introduced two ideas:

- **Local first**: run close to the user's machine and tools, so integrations can use existing CLIs, files, browser sessions, and local credentials instead of bespoke SaaS connectors.
- **Capabilities over workflows**: give the agent context, prompts, skills, and tools, then let the model decide how to compose them instead of forcing every task into a predefined workflow.

heypi extends these ideas with two safety layers:

- **Approvals**: require specific users or groups to approve sensitive operations, with every approval logged for audit.
- **Sandboxing**: run commands in a separate runtime, such as just-bash, Docker, or a MicroVM.

For example, the [Slack DevOps agent example](https://github.com/hunvreus/heypi/tree/main/examples/slack-devops) gives an AI agent access to servers through host tools. A safe request, such as "What is the load on db-1?", can run without approval. A risky request, such as running a database migration, will require approval from a specific user or group (someone on the DevOps team, for example).

## How it works

At its core, heypi wraps around [Pi](https://pi.dev), a minimalist open-source AI harness:

- It adds adapters for [Slack](adapters/slack.md), [Discord](adapters/discord.md), [Telegram](adapters/telegram.md), and [webhooks](adapters/webhook.md).
- It persists discussions, actors, turns, calls, approvals, and jobs in SQLite.
- It lets you customize behavior with prompts, [tools](configuration/tools.md), [skills](configuration/skills.md), [memory](configuration/memory.md), [secrets](configuration/secrets.md), [runtime providers](configuration/runtime.md), and [scheduling](configuration/scheduling.md).
- It enforces approval rules before the agent can run sensitive actions.

You can configure an agent with a single TypeScript or JavaScript file and run it as a long-running Node.js service.

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

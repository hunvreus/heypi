<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/heypi-white.png">
    <source media="(prefers-color-scheme: light)" srcset="docs/assets/heypi-black.png">
    <img alt="heypi" src="docs/assets/heypi-black.png" width="320">
  </picture>
</p>

# heypi

Chat agents for your team, with approvals and sandboxed tools. Slack, Discord, Telegram, webhooks.

Start here: [`@hunvreus/heypi` quickstart](packages/heypi/README.md).

This repository is a pnpm workspace for the core package and optional runtime providers.

## Packages

| Package | Description |
| --- | --- |
| [`@hunvreus/heypi`](packages/heypi/README.md) | Core chat-agent runtime, adapters, admin UI, tools, scheduler, and CLI. |
| [`@hunvreus/heypi-runtime-docker`](packages/heypi-runtime-docker/README.md) | Docker runtime provider with one warm container per heypi runtime scope. |
| [`@hunvreus/heypi-runtime-gondolin`](packages/heypi-runtime-gondolin/README.md) | Gondolin runtime provider with one warm VM per heypi runtime scope. |

## Examples

- [`examples/slack-devops`](examples/slack-devops): Slack DevOps assistant with runbook search, approvals, SSH host tools, and host inventory.
- [`examples/discord-project`](examples/discord-project): Discord project assistant with streaming, approvals, and simple project-state tools.
- [`examples/telegram-workout`](examples/telegram-workout): Telegram fitness coach with saved profile/plan and daily heartbeat check-ins.
- [`examples/webhook-notes`](examples/webhook-notes): tiny webhook note-taking agent with curl examples.

## Development

```bash
pnpm install
pnpm run check
pnpm run typecheck
pnpm run test
pnpm run build:all
pnpm run pack:dry:packages
```

Useful local runs:

```bash
pnpm run dev:slack
pnpm run dev:discord
pnpm run dev:telegram
pnpm run dev:webhook
```

## License

[MIT](LICENSE)

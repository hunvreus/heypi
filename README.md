<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="packages/heypi/docs/assets/heypi-white.png">
    <source media="(prefers-color-scheme: light)" srcset="packages/heypi/docs/assets/heypi-black.png">
    <img alt="heypi" src="packages/heypi/docs/assets/heypi-black.png" width="320">
  </picture>
</p>

# heypi

Team chat agents with approvals, audit, and sandboxed tools. Slack, Discord, Telegram, and trusted webhooks.

heypi is for governed chat-ops agents that work in shared channels while keeping sensitive actions reviewable. This repo contains the core heypi package, optional runtime providers, and runnable examples.

[Start here: `packages/heypi`](packages/heypi/README.md#minimal-app)

## Packages

- [`packages/heypi`](packages/heypi): Core framework: adapters, tools, approvals, state, admin, scheduler, CLI.
- [`packages/create-heypi`](packages/create-heypi): App scaffolder for `npm create heypi@latest`.
- [`packages/heypi-runtime-docker`](packages/heypi-runtime-docker): Docker runtime provider with one warm container per runtime scope.
- [`packages/heypi-runtime-gondolin`](packages/heypi-runtime-gondolin): Gondolin runtime provider with one warm VM per runtime scope.

## Examples

- [`examples/slack-devops`](examples/slack-devops): Slack DevOps assistant with runtime tools, runbooks, memory, secrets, SSH host inventory, and approvals.
- [`examples/discord-gondolin`](examples/discord-gondolin): Discord project assistant with Gondolin, memory, scoped skills, secret requests, and file attachments.
- [`examples/telegram-workout`](examples/telegram-workout): Telegram fitness coach with saved profile/plan and heartbeat check-ins.
- [`examples/webhook-github-docker`](examples/webhook-github-docker): GitHub issue automation with webhook input, Docker repo inspection, and trusted GitHub writeback.

## Development

```bash
pnpm install
pnpm run check
pnpm run typecheck
pnpm run test
pnpm run build:all
```

Run examples:

```bash
(cd examples/slack-devops && pnpm dev)
(cd examples/discord-gondolin && pnpm dev)
(cd examples/telegram-workout && pnpm dev)
(cd examples/webhook-github-docker && pnpm dev)
```

Dry-run packages before publishing:

```bash
pnpm run pack:dry:packages
pnpm run publish:dry:packages
```

## License

[MIT](LICENSE)

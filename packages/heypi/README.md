<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/logo-white.svg">
    <source media="(prefers-color-scheme: light)" srcset="docs/assets/logo-black.svg">
    <img alt="heypi" src="docs/assets/logo-black.svg" width="320">
  </picture>
</p>

# heypi

Pi-native chat adapters for team agents.

heypi connects Pi agents to Slack, Discord, Telegram, webhooks, and local chat. Pi owns the model
loop, tools, extensions, sessions, and compaction; heypi provides chat transport, approvals,
resource staging, runtimes, scheduling, and coordination.

[Documentation](https://heypi.dev/docs/) · [Quickstart](https://heypi.dev/docs/getting-started/) ·
[Configuration](https://heypi.dev/docs/configuration/) · [GitHub](https://github.com/hunvreus/heypi)

## Install

```sh
npm install @hunvreus/heypi
```

## Quickstart

```ts
import { host, loadAgent, local, modelFromEnv, runHeypi } from "@hunvreus/heypi";

const agent = loadAgent("./agent", {
	model: modelFromEnv(),
	runtime: host({ workspace: "./workspace" }),
});

await runHeypi(agent, [local()]);
```

`modelFromEnv()` reads `HEYPI_MODEL` in `provider/model` form. Provider credentials use Pi's
standard authentication and environment variables.

## Create an agent

Start from the Codex Tag template:

```sh
npm create heypi@latest -- codex-tag
```

Templates include the agent files, adapter setup, runtime configuration, and environment example
needed to run a working project.

## Included

- Slack, Discord, Telegram, webhook, and local adapters
- Host and Docker runtimes
- Approvals, todos, memory, attachments, secrets, schedules, and audit logs
- Runtime packages for Cloudflare Sandbox, Gondolin, just-bash, and Vercel Sandbox
- Typed configuration and CLI setup helpers

Host execution is not a sandbox. Use Docker or another isolated runtime for model-driven commands
unless host access is intentional.

## Documentation

Read the [hosted documentation](https://heypi.dev/docs/) for configuration, adapters, runtime
isolation, deployment, custom tools, and API reference. The same documentation is included in this
package under [`docs/`](docs/).

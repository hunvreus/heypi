<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="packages/heypi/docs/assets/logo-white.svg">
    <source media="(prefers-color-scheme: light)" srcset="packages/heypi/docs/assets/logo-black.svg">
    <img alt="heypi" src="packages/heypi/docs/assets/logo-black.svg" width="320">
  </picture>
</p>

# heypi

Pi-native chat agents for teams.

heypi connects one Pi agent to Slack, Discord, Telegram, local applications, or trusted webhooks.
It adds conversation routing, runtime isolation, approvals, memory, attachments, schedules, and
operational audit records without replacing Pi's model loop.

[Documentation](https://heypi.dev/docs/) · [Quickstart](https://heypi.dev/docs/getting-started/) ·
[Discord](https://heypi.dev/chat)

## Create an agent

```sh
npm create heypi@latest -- codex-tag my-agent
cd my-agent
cp .env.example .env
npm run dev
```

## Use as a library

```sh
npm install @hunvreus/heypi
```

```ts
import { host, loadAgent, local, modelFromEnv, runHeypi } from "@hunvreus/heypi";

const agent = loadAgent("./agent", {
	model: modelFromEnv(),
	runtime: host({ workspace: "./workspace" }),
});

await runHeypi(agent, [local()]);
```

Set `HEYPI_MODEL` to a Pi model ID such as `openai/gpt-5.4-mini` and provide that model provider's
credentials. Replace `local()` with Slack, Discord, Telegram, or webhook for network ingress.

## Packages

- [`@hunvreus/heypi`](packages/heypi): agent lifecycle, adapters, approvals, and host/Docker runtimes.
- [`@hunvreus/heypi-runtime-just-bash`](packages/heypi-runtime-just-bash): confined in-process interpreter.
- [`@hunvreus/heypi-runtime-gondolin`](packages/heypi-runtime-gondolin): local QEMU micro-VM.
- [`@hunvreus/heypi-runtime-vercel`](packages/heypi-runtime-vercel): managed Vercel Sandbox.
- [`@hunvreus/heypi-runtime-cloudflare`](packages/heypi-runtime-cloudflare): Cloudflare Sandbox SDK adapter.
- [`create-heypi`](packages/create-heypi): project scaffolder.

The canonical documentation source is [`packages/heypi/docs`](packages/heypi/docs). The complete
hosted documentation is at [heypi.dev/docs](https://heypi.dev/docs/).

## Development

Requires Node.js 22 or later and pnpm 10.

```sh
pnpm install
pnpm check
pnpm typecheck
pnpm test
pnpm build
```

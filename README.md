# heypi

Pi-native chat adapters for team agents.

The active package is [packages/heypi](packages/heypi). This rebuild keeps Pi responsible for model
execution, transcript, compaction, retries, tools, extensions, and session state. heypi handles chat
adapters, agent folder loading, resource staging, approvals, and small coordination state.

## Commands

```sh
corepack pnpm install
corepack pnpm run check
corepack pnpm run typecheck
corepack pnpm run test
corepack pnpm run build
```

## Packages

- [`@hunvreus/heypi`](packages/heypi) provides the agent, adapters, and host/Docker runtimes.
- [`@hunvreus/heypi-runtime-just-bash`](packages/heypi-runtime-just-bash) provides lightweight
  interpreter isolation.
- [`@hunvreus/heypi-runtime-gondolin`](packages/heypi-runtime-gondolin) provides local micro-VM
  isolation.
- [`@hunvreus/heypi-runtime-vercel`](packages/heypi-runtime-vercel) provides managed Vercel
  Sandbox execution.
- [`@hunvreus/heypi-runtime-cloudflare`](packages/heypi-runtime-cloudflare) adapts a caller-owned
  Cloudflare Sandbox SDK instance.

## Quick start

```ts
import { host, loadAgent, local, modelFromEnv, runHeypi } from "@hunvreus/heypi";

const agent = loadAgent("./agent", {
	model: modelFromEnv(),
	runtime: host({ workspace: "./workspace" }),
});

await runHeypi(agent, [local()]);
```

Set `HEYPI_MODEL` to a Pi model ID such as `openai/gpt-5.4-mini` and configure that provider's
credentials. The local adapter is intended for embedding and tests; use Slack, Discord, Telegram,
or webhook for network ingress.

See [packages/heypi/README.md](packages/heypi/README.md) for the API and runtime selection guide.

## Examples

- [examples/codex-tag](examples/codex-tag) is the minimal current feature testbed for Slack/local
  chat, approval rendering, todo progress, memory, explicit history, and long-task Pi session
  behavior.

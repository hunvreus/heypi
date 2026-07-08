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

## Package

```ts
import { createHeypi, loadAgent, local } from "@hunvreus/heypi";

const agent = loadAgent("./agent", {
	model,
});

const app = await createHeypi({
	agent,
	adapters: [local()],
});
await app.start();
```

See [packages/heypi/README.md](packages/heypi/README.md) for the current API surface.

## Examples

- [examples/codex-tag](examples/codex-tag) is the minimal current feature testbed for Slack/local
  chat, approval rendering, todo progress, memory, explicit history, and long-task Pi session
  behavior.

# heypi

Pi-native chat adapters for team agents.

The active package is [packages/heypi](/Users/hunvreus/Workspace/biots/packages/heypi). This rebuild
keeps Pi responsible for model execution, transcript, compaction, retries, tools, extensions, and
session state. heypi handles chat adapters, agent folder loading, resource staging, approvals, and
small coordination state.

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
	adapters: [local()],
});

const app = await createHeypi({ agent });
await app.start();
```

See [packages/heypi/README.md](/Users/hunvreus/Workspace/biots/packages/heypi/README.md) for the
current API surface.

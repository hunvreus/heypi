# heypi

Pi-native chat adapters for team agents.

heypi is being rebuilt as a small shell around [Pi](https://pi.dev). Pi owns the
agent session, transcript, compaction, retries, tool execution, and extension
state. heypi owns chat adapters, agent folder loading, resource staging, and
product surfaces such as approvals.

## Current package

- [`packages/heypi`](packages/heypi): core Pi-native adapter shell.

Examples will be rebuilt after the Pi-native core settles.

## Minimal shape

```ts
import { createHeypi, loadAgent, slack } from "@hunvreus/heypi";

const agent = loadAgent("./agent", {
  model,
  adapters: [slack({ token: process.env.SLACK_BOT_TOKEN })],
});

const app = await createHeypi({ agent });
await app.start();
```

Agent folders are still file-based:

```text
agent/
  config.json
  instructions.md
  system.md
  skills/
  tools/
  extensions/
```

## Development

```bash
corepack pnpm install
corepack pnpm run check
corepack pnpm run typecheck
corepack pnpm run test
corepack pnpm run build
```

## License

[MIT](LICENSE)

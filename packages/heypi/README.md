# heypi

Pi-native chat adapters for team agents.

heypi is being rewritten as a small shell around [Pi](https://pi.dev). Pi owns the model loop,
transcript, compaction, retries, tools, extensions, and session state. heypi owns chat ingress and
egress, agent folder loading, resource staging, and later product UI for approvals/admin.

## Current shape

```ts
import { createHeypi, loadAgent, slack } from "@hunvreus/heypi";

const agent = loadAgent("./agent", {
  model,
  adapters: [slack({ token: process.env.SLACK_BOT_TOKEN, appToken: process.env.SLACK_APP_TOKEN })],
});

const app = await createHeypi({ agent });
await app.start();
```

Agent resources are file-based:

```text
agent/
  instructions.md
  system.md
  skills/
  tools/
  extensions/
```

`agent/` is staged into a Pi-visible bundle. `skills/` and `extensions/` are loaded by Pi. Files in
`tools/` are passed to Pi as extension paths so tool execution stays inside Pi.

## Included now

- `loadAgent("./agent", options)`
- Pi session runtime creation via `@earendil-works/pi-coding-agent`
- Current-turn chat delivery with older chat available through the Pi `chat_history` tool
- Model-authored progress updates through the Pi `chat_reply` tool
- Slack, Discord, Telegram, and webhook adapter shells
- Approval message rendering helper

## Not included yet

- Approval execution as a Pi extension
- Memory as a Pi extension
- Todo/planning as a Pi extension
- Admin/event mirror
- Docker/Gondolin runtime extensions
- Cleaned examples

## License

[MIT](LICENSE)

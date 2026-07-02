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
  config.json
  instructions.md
  system.md
  skills/
  tools/
  extensions/
```

`config.json` can define data options such as `id`, `context`, `approvals`, `state`, `tools`,
`excludeTools`, and `noTools`. Options passed to `loadAgent()` override the file.

`context.range` is either `current` or `delta`. `current` sends only the triggering chat message to
Pi. `delta` sends chat messages since the last completed trigger. Older chat is not passively
injected; Pi can ask for it with `chat_history`.

`agent/` is staged into a clean Pi-visible bundle on startup. `skills/` and `extensions/` are
loaded by Pi. Files in `tools/` are passed to Pi as extension paths so tool execution stays inside
Pi.

## Included now

- `loadAgent("./agent", options)`
- Agent `config.json` discovery for data-only options
- Pi session runtime creation via `@earendil-works/pi-coding-agent`
- Current-turn chat delivery with older chat available through the Pi `chat_history` tool
- Model-authored progress updates through the Pi `chat_reply` tool
- Slack, Discord, Telegram, and webhook adapter shells
- Approval tool-call gating through a Pi extension boundary
- Built-in Slack approval buttons; `onApproval` hooks for other adapters

## Not included yet

- Built-in Discord/Telegram approval button implementations
- Memory as a Pi extension
- Todo/planning as a Pi extension
- Admin/event mirror
- Docker/Gondolin runtime extensions
- Rebuilt examples

## License

[MIT](LICENSE)

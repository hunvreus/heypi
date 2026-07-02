# heypi

Pi-native chat adapters for team agents.

heypi is a thin product shell around Pi. Pi owns the model loop, session state, compaction, retries,
tools, extensions, and transcript. heypi owns agent folder loading, resource staging, chat adapters,
approval UI, and small adapter coordination.

## Usage

```ts
import { createHeypi, loadAgent, local } from "@hunvreus/heypi";

const adapter = local();
const agent = loadAgent("./agent", {
	model,
	adapters: [adapter],
	approvals: { layout: "message" },
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

`config.json` can define data-only defaults such as `id`, `context`, `approvals`, `state`, `tools`,
`excludeTools`, and `noTools`. Options passed to `loadAgent()` override the file.

The agent folder is copied into a clean Pi-visible bundle under `.heypi`. Pi loads staged resources
from that bundle; heypi does not expose host source paths to the model.

## Current scope

Included:

- `loadAgent("./agent", options)`
- clean staging for `instructions.md`, `system.md`, `skills/`, `tools/`, and `extensions/`
- Pi session creation through `@earendil-works/pi-coding-agent`
- local adapter for tests and embedding
- webhook adapter for simple HTTP ingress
- Slack Socket Mode adapter shell with replies, reactions, and approval buttons
- Discord adapter shell with mention/DM normalization, replies, and approval buttons
- Telegram adapter shell with polling, mention/DM normalization, replies, and approval buttons
- approval message rendering and Pi tool-call approval extension
- `chat_history` and `chat_reply` Pi tools for explicit older-context lookup and sparse progress updates

Not included yet:

- Card-style approval attachments beyond Slack/Discord/Telegram native buttons
- approval buttons/cards in live adapters
- memory, todo/planning, admin, and runtime providers

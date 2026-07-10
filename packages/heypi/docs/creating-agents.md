# Creating agents

heypi agents are Pi-native. Pi owns the model loop, sessions, compaction, tools, and extensions.
heypi connects chat adapters to Pi and mirrors enough state for approvals, audit, and admin.

## Folder shape

```text
agent/
  instructions.md
  system.md
  skills/
  tools/
  extensions/
```

- `instructions.md` is the stable behavior contract.
- `system.md` is optional low-level system context.
- `skills/` holds on-demand procedures available to Pi.
- `tools/` holds authored Pi extension files that register local tools.
- `extensions/` holds Pi extensions discovered from the staged bundle.

heypi stages this folder into `.heypi` before Pi sees it. Do not rely on host source paths.

## Entry point

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

## History

heypi sends the current trigger to Pi and keeps older messages out of the prompt path. Older messages
are available through the `chat_history` tool. Prefer `chat_history` when the model needs context
instead of carrying broad passive chat history on every turn.

Thread-capable adapters include the native thread id in the heypi conversation key. Channel-level
messages without a thread share the channel-level key.

## Skills

Keep always-on instructions short. Put longer procedures in `skills/`, where Pi can load them only
when needed.

```text
agent/skills/release/SKILL.md
```

```md
---
description: Prepare and validate package releases.
---

Check tests, package metadata, changelog entries, and publish dry-runs before release.
```

## Approvals

Approvals run at the Pi tool-call boundary. They are policy and UX, not a sandbox. Runtime isolation
is the security boundary for filesystem, command, and network effects.

Adapter config controls approval rendering and who can approve. Tool config controls whether a tool
call needs approval.

```ts
const adapter = slack({
  token,
  appToken,
  admins: { users: envList("SLACK_ADMINS") },
  approvers: { users: envList("SLACK_APPROVERS") },
  approvals: { layout: "message", timeoutMs: 60_000 },
});

const agent = loadAgent("./agent", {
  tools: {
    bash: {
      approve: approval.command(),
    },
  },
});
```

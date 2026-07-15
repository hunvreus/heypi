# Pi-native heypi rewrite plan

## Goal

Rewrite heypi as a small Pi-native chat adapter shell. Pi owns the model loop, session state,
compaction, retries, extension state, and tool execution semantics. heypi owns chat ingress/egress,
configuration, resource staging, adapter auth, and later product UI around approvals/admin.

This branch is a fresh rewrite branch. Do not preserve old heypi internals unless they fit this
boundary cleanly.

## Target architecture

```text
Slack/Discord/Telegram/Webhook
  -> adapter event
  -> conversation runtime/log
  -> Pi session/job
  -> Pi events/assistant output
  -> adapter renderer
```

heypi must not assemble long model prompts, own compaction, own the agent loop, or maintain a
parallel transcript for model execution.

## Target API shape

heypi should keep a declaration/runtime split:

```ts
const agent = loadAgent("./agent", {
  model: modelFromEnv(),
  runtime: host({ workspace: "./workspace" }),
  extensions: [todo(), memory()],
});

const app = createHeypi({
  agent,
  adapters: [
    slack({
      token,
      appToken,
      status: true,
    }),
  ],
});

await app.start();
```

`loadAgent("./agent")` is the agent declaration step. It auto-discovers:

```text
agent/
  instructions.md
  system.md
  skills/
  tools/
  extensions/
```

`createHeypi()` wires that agent to adapters and starts the app. Do not flatten the API into one
giant `createHeypi({ model, runtime, adapters, tools, skills, ... })` object.

### Config ownership

- Top-level agent config is only for cross-cutting runtime setup:
  - `model`
  - `runtime`
  - `extensions`
  - optional `admin`
- Adapter config owns platform behavior:
  - inbound filtering/auth/context through hooks such as `onMessage`
  - activity UX through adapter defaults and event overrides
  - platform primitives such as Slack reactions
  - thread/DM/channel behavior
- Tool/runtime definitions own action safety:
  - approval predicates
  - command classification
  - runtime-backed command/file operations
- Todo, memory, and later planning are Pi extensions/tools, not prompt machinery or global feature
  flags.

### Adapter defaults

Adapters must work with minimal configuration and strong defaults.

- Slack:
  - app mentions and DMs are accepted by default when adapter allow rules permit them.
  - inbound accepted turns immediately set Slack's native assistant status to `Thinking...`.
  - when Pi starts a tool, the native status updates to `Working...`.
  - approvals clear the native status while paused and restore it when work resumes.
  - posting a terminal reply clears the native status without a separate API call.
  - app mentions get an immediate `eyes` reaction by default; `reaction` accepts another emoji name
    or `false`.
- Discord and Telegram:
  - native typing indicators are used by default.
  - no text progress messages are posted.

Ignored, denied, empty, or invalid adapter events must not start Pi work and must not leave progress
behind.

### Progress API

Do not keep a global progress DSL. This is the wrong shape:

```ts
loadAgent("./agent", {
  progress: {
    resolution: "coarse",
    thinking: "Thinking...",
    working: "Working...",
    compacting: "Compacting...",
  },
});
```

Use adapter defaults plus small adapter-local switches:

```ts
slack({ status: false });
```

Advanced customization uses adapter event hooks. Setting a Slack lifecycle event to `false` disables
its built-in status behavior for that event.

### Approval API

Approval is tool/runtime semantics, not global app policy.

Tool definitions should be able to request approval:

```ts
export default tool({
  description: "Deploy the app",
  input,
  approve: async ({ input, actor }) => {
    if (input.environment === "production") {
      return {
        reason: "Deploy to production",
        approvers: ["U_RONAN"],
      };
    }

    return false;
  },
  async run(input, ctx) {
    return ctx.runtime.bash("pnpm deploy");
  },
});
```

Runtime-backed built-in operations such as bash/write/edit should accept the same approval predicate
shape. heypi should provide convenience classifiers, but no default global approval policy.

Adapters render approval UI. Layout is adapter-specific:

```ts
slack({
  approval: {
    layout: "message",
  },
});
```

The tool provides semantic approval fields such as reason, title, approvers, and details. The adapter
decides whether those render as Slack message layout, Slack Block Kit, Discord buttons, Telegram inline
keyboard, local prompt, or webhook event.

### Context/history API

Do not keep a global `context.history` enum. The adapter hook decides what extra context, if any, is
attached to a trigger:

```ts
slack({
  async onMessage(ctx, message) {
    if (message.dm) return ctx.default();

    return ctx.default({
      context: await ctx.thread.messagesSinceLastReply(),
    });
  },
});
```

Older channel history remains available through explicit Pi tools such as `chat_history`; it is not
dumped into every prompt.

### Agent resource loading

The folder is the normal authoring interface. Do not make users write:

```ts
tools: loadTools("./agent/tools"),
skills: loadSkills("./agent/skills"),
```

Resource folders are auto-discovered by `loadAgent("./agent")`. Programmatic extension arrays are for
code-defined extensions such as `todo()` and `memory()`, not for restating the folder shape.

Stage authored resources into a Pi-visible bundle instead of exposing host source paths.

- Map `system.md` to Pi `SYSTEM.md`.
- Map `instructions.md` to Pi `APPEND_SYSTEM.md`.
- Stage `skills/`, `tools/`, and `extensions/` as Pi-visible resources.

### Conversation runtime

Implement a minimal conversation runtime inspired by `../_sandbox/pi-chat`:

- append inbound adapter records,
- trigger Pi jobs from mentions, DMs, webhooks, or local messages,
- send only the current trigger plus hook-provided context to Pi,
- do not own Pi transcript, compaction, retries, or tool-result shaping.

Do not implement Docker or Gondolin runtimes in the first pass. Use Pi-chat's Gondolin boundary only as
inspiration for future runtime providers.

## Current state

- Agent folder loading and Pi-visible staging are implemented.
- Local, webhook, Slack, Discord, and Telegram adapter shells are implemented.
- Approval policy and adapter-rendered approval UI are implemented at the Pi tool-call boundary.
- `chat_history`, `todo_update`, `memory_store`, and `memory_search` are Pi tools.
- Admin/audit reads heypi-owned adapter coordination logs; it does not drive model context.

## Next build

- Keep adding tests with each feature.
- Tighten adapter parity where current shells are still minimal.
- Add the runtime boundary below without moving model-loop ownership out of Pi.

## Runtime plan

heypi runtime support should select where Pi-visible tools execute. It must not reimplement Pi's
session loop, compaction, transcript, retry policy, or tool-result shaping.

### Local

Status: implemented.

- Uses Pi directly in a host workspace.
- `workspace` selects the working directory.
- Best for development, tests, and trusted personal agents.

### just-bash

Status: planned.

- Integrates with Vercel Labs `just-bash` as a virtual bash/filesystem provider.
- Useful for lightweight isolated command execution where a full container is unnecessary.
- Should still plug into Pi's existing core tool definitions through runtime-backed operations.

### Docker

Status: planned.

- Runs command/file effects inside a container workspace.
- Stages agent resources read-only and mounts or copies the selected workspace separately.
- Exposes only runtime-visible paths to Pi.
- Implements runtime-backed operations for Pi's `bash`, `read`, `write`, `edit`, `find`, `grep`,
  and `ls` tools instead of defining replacement heypi tools.
- Should provide explicit lifecycle hooks: prepare, start, stop, clean, health.
- Good enough target for shared Slack/Discord demos before adding Gondolin.

### Gondolin-style provider

Status: later.

- Same conceptual boundary as Docker, but remote/durable.
- Should plug into the runtime interface after local/bash/docker are stable.
- Do not add Gondolin-specific assumptions to core chat/adapters.

## Examples

The first example is `examples/codex-tag`. It should stay small and cover the current feature set:

- Slack/local entry points where possible.
- `instructions.md`, `system.md`, `skills/`, `tools/`, and `extensions/` staging.
- Approval UI and default command policy.
- Todo/progress tool.
- Memory tools.
- Explicit history lookup via `chat_history`.
- Long-task testing through Pi's own compaction/session behavior, not heypi context budgets.

## Later features

- Richer admin UI over mirrored Pi/session/adapter events.
- Todo as a first-class Pi extension with replayable state and heypi chat rendering, informed by
  `rpiv-todo` and `pi-tasks`.
- Memory as a first-class Pi extension with explicit store/search tools plus Pi-native recall,
  observe, shutdown, and compaction hooks, informed by `pi-hermes-memory` and `remnic/plugin-pi`.
- Generated skills through Pi-native extension/tooling.
- Subagents through Pi-native extensions, not prompt machinery.
- Docker/Gondolin-style runtime providers behind the runtime boundary.

## Non-goals

- No compatibility with old heypi APIs.
- No heypi-owned context compaction, tool-result budgets, replay loop, or managed memory.
- No feature should be kept just because current examples/tests use it.

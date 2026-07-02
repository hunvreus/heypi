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

## Initial build

- Keep package shape only where it helps users:
  - `loadAgent("./agent", { model, adapters, ... })`
  - `agent/instructions.md`
  - `agent/system.md`
  - `agent/tools/`
  - `agent/skills/`
  - `agent/extensions/`
- Stage authored resources into a Pi-visible bundle instead of exposing host source paths.
- Implement a minimal conversation runtime inspired by `../_sandbox/pi-chat`:
  - append inbound records,
  - trigger jobs from mentions/DM/webhook,
  - send only the current chat delta to Pi,
  - expose older history through explicit tools later.
- Support Slack, Discord, Telegram, and webhook as adapter shells.
- Do not implement Docker or Gondolin runtimes in the first pass. Use Pi-chat’s Gondolin boundary only
  as inspiration for future runtime providers.
- Ignore examples until the new core compiles and the basic chat flow works.

## Later features

- Approvals: Pi extension plus heypi adapter UI for approval cards/messages.
- Memory: Pi extension, not heypi prompt injection.
- Todo/planning: Pi extension plus heypi renderer, not model-managed core planning.
- Admin: mirror Pi/session/adapter events, do not drive model context.
- Runtimes: add provider boundaries after the core is Pi-native.

## Non-goals

- No compatibility with old heypi APIs unless they match the new boundary.
- No heypi-owned context compaction, tool-result budgets, replay loop, or managed memory.
- No feature should be kept just because current examples/tests use it.

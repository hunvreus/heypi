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

Status: first clean baseline is in place.

- Keep package shape only where it helps users:
  - `loadAgent("./agent", { model, adapters, ... })`
  - `agent/instructions.md`
  - `agent/system.md`
  - `agent/tools/`
  - `agent/skills/`
  - `agent/extensions/`
- Stage authored resources into a Pi-visible bundle instead of exposing host source paths.
  - Map `system.md` to Pi `SYSTEM.md`.
  - Map `instructions.md` to Pi `APPEND_SYSTEM.md`.
- Implement a minimal conversation runtime inspired by `../_sandbox/pi-chat`:
  - append inbound records,
  - trigger jobs from mentions/DM/webhook,
  - send only the current chat delta to Pi,
  - do not own Pi transcript, compaction, retries, or tool-result shaping.
- Include a local adapter for tests and embedding.
- Do not implement Docker or Gondolin runtimes in the first pass. Use Pi-chat’s Gondolin boundary only
  as inspiration for future runtime providers.
- Ignore examples until the new core compiles and the basic chat flow works.
- Gate risky Pi tool calls through programmable approval policies and adapter-rendered approval UI.

## Current state

- Agent folder loading and Pi-visible staging are implemented.
- Local, webhook, Slack, Discord, and Telegram adapter shells are implemented.
- Approval policy and adapter-rendered approval UI are implemented at the Pi tool-call boundary.
- `chat_history`, `chat_reply`, `todo_update`, `memory_store`, and `memory_search` are Pi tools.
- Admin/audit reads heypi-owned adapter coordination logs; it does not drive model context.

## Next build

- Keep adding tests with each feature.
- Tighten adapter parity where current shells are still minimal.
- Add non-local runtime providers only after the local Pi-native boundary stays small.

## Later features

- Richer admin UI over mirrored Pi/session/adapter events.
- Generated skills through Pi-native extension/tooling.
- Subagents through Pi-native extensions, not prompt machinery.
- Docker/Gondolin-style runtime providers behind the runtime boundary.

## Non-goals

- No compatibility with old heypi APIs unless they match the new boundary.
- No heypi-owned context compaction, tool-result budgets, replay loop, or managed memory.
- No feature should be kept just because current examples/tests use it.

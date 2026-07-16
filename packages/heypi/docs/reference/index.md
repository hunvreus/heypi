# Reference

## Entrypoints

| Import | Purpose |
| --- | --- |
| `@hunvreus/heypi` | Agent loading, app lifecycle, adapters, built-in runtimes, approvals, and public types |
| `@hunvreus/heypi/authoring` | Pi `defineTool`, extension types, TypeBox `Type`, and `defineSchedule` |
| `@hunvreus/heypi/runtime` | Runtime provider contracts and runtime-backed Pi core tools |

The exported TypeScript declarations are the authoritative API reference.

## Adapter events

Stable event discriminants:

- `message_accepted`
- `message_queued`
- `message_steered`
- `message_rejected`
- `message_failed`
- `turn_started`
- `tool_started`
- `todo_changed`
- `message_completed`
- `turn_canceled`
- `turn_failed`

Set an adapter event handler to `false` to disable its default. A custom handler replaces the
default for that event.

## Runtime paths

Pi sees `/workspace` and optional `/shared`. The default state root is `.heypi`; source agent files
are staged before Pi loads them.

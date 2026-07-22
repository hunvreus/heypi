# API

## Package entrypoints

| Import | Purpose |
| --- | --- |
| `@hunvreus/heypi` | Agent lifecycle, adapters, host/Docker runtimes, approvals, schedules, audit readers, and public types |
| `@hunvreus/heypi/authoring` | Pi `defineTool`, extension types, TypeBox `Type`, and `defineSchedule` |
| `@hunvreus/heypi/runtime` | Runtime contracts, mirrors, path helpers, and runtime-backed Pi core tools |

The package's exported TypeScript declarations are the authoritative symbol reference. The main
application path is `loadAgent()` plus `runHeypi()`. Use `createHeypi()` when an embedding host needs
to control startup or inject a Pi host factory.

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

Pi-derived events are normalized before adapters receive them. A custom event handler replaces the
adapter default; setting an event to `false` disables it.

```ts
slack({
	token,
	appToken,
	events: {
		message_queued: false,
	},
});
```

## Core contracts

- `Adapter` owns transport lifecycle, delivery, optional updates, attachment materialization, and
  approval UI.
- `ChatMessage` is normalized inbound identity and routing data.
- `RuntimeProvider` owns every Pi file and command tool for one runtime instance.
- `ApprovalPolicy` returns allow, approval, or block decisions at a tool boundary.
- `ScheduleDefinition` describes a cron prompt or trusted handler.

See the [custom adapter](../guides/custom-adapters.md), [custom runtime](../guides/custom-runtimes.md),
and [custom tool](../guides/custom-tools.md) guides for implementations.

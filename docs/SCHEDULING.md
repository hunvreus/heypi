# Scheduling

heypi supports two scheduled event types:

- `cron`: run an agent turn at a wall-clock schedule.
- `heartbeat`: run proactive turns for matching chats after a schedule and optional idle window.

Scheduling is not a workflow engine. A job creates a normal heypi turn, uses the same thread history, and delivers through the configured adapter.

## Model

A job has:

- `schedule`: `{ at }`, `{ everyMs }`, or `{ cron, timezone }`
- `scope`: optional scheduled-job target filter for adapters, teams, channels, and users
- `idleMs`: optional heartbeat idle window
- `target`: optional delivery target
- `prompt`: the synthetic message sent into the agent

Defaults:

- missing `scope` means every known chat is eligible
- `cron` without `target` runs only when exactly one target can be resolved
- `heartbeat` without `target` runs once per matched chat
- Slack cron jobs should usually set `target`
- Telegram personal bots can rely on known chats after the user has messaged once

`scope` is only for scheduled outbound jobs. It does not restrict inbound chat messages; use adapter `allow` for that.

## Example

```ts
createHeypi({
  // ...store, adapters, agent, runtime
  jobs: [
    {
      id: "daily-checkin",
      kind: "heartbeat",
      everyMs: 24 * 60 * 60 * 1000,
      idleMs: 8 * 60 * 60 * 1000,
      scope: { adapters: ["telegram"] },
      prompt: "Run the daily check-in skill.",
    },
    {
      id: "weekly-ops",
      kind: "cron",
      schedule: { cron: "0 9 * * 1", timezone: "America/Los_Angeles" },
      target: { adapter: "slack", channel: "C123" },
      prompt: "Run the weekly ops review.",
    },
  ],
});
```

## Reliability

The scheduler stores job definitions and run attempts in SQLite, uses durable locks to avoid duplicate execution across processes, and uses idempotent event IDs for each job run target.

Job output is recorded in `job_run`. Delivery is tracked separately from execution.

Custom stores that support scheduling must provide `jobs`, `jobRuns`, and `locks`. They should also implement `transaction()` so job run updates and job cursor updates can commit atomically. Nested transactions are not supported. `idleMs` is a first-class `Job` field, not part of serialized `scope`.

Agents can suppress delivery for a scheduled run by returning a structured `silent` response. The built-in Pi adapter maps an exact `[SILENT]` response to that structured flag for prompt-level ergonomics.

## Intentional Non-Goals

- chat-based job editing
- workflow DAGs
- arbitrary pre-run scripts
- multi-target fanout
- web admin UI

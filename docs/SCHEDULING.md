# Scheduling

heypi supports two scheduled event types:

- `cron`: run an agent turn at a wall-clock schedule.
- `heartbeat`: run proactive turns for matching chats after a schedule and optional idle window.

Scheduling is not a workflow engine. A job creates a normal heypi turn, uses the same thread history, and delivers through the configured adapter.

Jobs run inside the heypi Node process. No external system cron is required. Keep the process running for scheduled work to fire.

## Model

A job has:

- `schedule`: `{ at }`, `{ everyMs }`, or `{ cron, timezone }`
- `targets`: concrete delivery destinations, keyed by adapter name
- `scope`: heartbeat filter over known threads, keyed by adapter name
- `idleMs`: optional heartbeat idle window
- `prompt`: the synthetic message sent into the agent

Routing rules:

- `cron` jobs require `targets`.
- `heartbeat` jobs require either `scope` or `targets`.
- `idleMs` only applies to scoped heartbeat jobs over known threads.
- `targets` and `scope` are mutually exclusive.

Adapter keys are configured adapter names, not provider kinds. If you configure `slack({ name: "acme", ... })`, use `acme` as the key. `scope` is only for scheduled outbound jobs. It does not restrict inbound chat messages; use adapter `allow` for that.

Jobs are stored under `(agent, id)`. Two agents can use the same job id in the same DB without executing or overwriting each other's jobs. Startup reconciles code-defined jobs for the current agent: configured jobs are installed or updated, jobs removed from config are paused, and manual CLI pause/resume state is preserved unless the job config explicitly sets `state`.

## Example

```ts
createHeypi({
  // ...state, adapters, agent, runtime
  jobs: [
    {
      id: "daily-checkin",
      kind: "heartbeat",
      everyMs: 24 * 60 * 60 * 1000,
      idleMs: 8 * 60 * 60 * 1000,
      scope: { telegram: {} },
      prompt: "Run the daily check-in skill.",
    },
    {
      id: "weekly-ops",
      kind: "cron",
      schedule: { cron: "0 9 * * 1", timezone: "America/Los_Angeles" },
      targets: { slack: { channels: ["C123"] } },
      prompt: "Run the weekly ops review.",
    },
  ],
});
```

Concrete targets can address channels or users:

```ts
targets: {
  acme: {
    channels: ["C123", "C456"],
    users: ["U123"],
  },
}
```

Scoped heartbeats fan out over stored threads matching the adapter filters:

```ts
scope: {
  acme: { teams: ["T123"], channels: ["C123"] },
}
```

## Reliability

The scheduler stores job definitions and run attempts in SQLite, uses durable locks to avoid duplicate execution across processes, and uses idempotent event IDs for each job run target.

Job output is recorded in `job_run`. Delivery is tracked separately from execution.

Target failures are recorded as failed `job_run` rows. The job cursor still advances after the scheduled attempt, so transient provider delivery failures are visible in history but are not retried automatically by the scheduler.

Custom stores that support scheduling must provide `jobs`, `jobRuns`, and `locks`. They should also implement `transaction()` so job run updates and job cursor updates can commit atomically. Nested transactions are not supported. `idleMs` is a first-class `Job` field, not part of serialized `scope`.

Agents can suppress delivery for a scheduled run by returning a structured `silent` response. The built-in Pi adapter maps an exact `[SILENT]` response to that structured flag for prompt-level ergonomics.

## Limits

- chat-based job editing
- workflow DAGs
- arbitrary pre-run scripts
- chat-based target discovery

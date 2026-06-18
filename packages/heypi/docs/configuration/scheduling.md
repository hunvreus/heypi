# Scheduling

Scheduling lets heypi start agent turns without an inbound chat message.

- `cron`: runs at a wall-clock schedule and sends to explicit targets.
- `heartbeat`: runs proactive turns for known chats, optionally only after they have been idle.

A scheduled job creates a normal heypi turn. It uses the same agent, runtime, tools, thread history, and adapter delivery path as a chat message.

Jobs run inside the heypi Node process. Keep the process running for scheduled work to fire.

Scheduled turns use the same approval policy as chat turns. If a scheduled turn reaches an approval-gated tool, heypi creates a normal pending approval and waits for approve, deny, or expiry.

If a scheduled turn returns exactly `[SILENT]`, heypi records the turn without sending a chat message. Use this when the job should only act through tools or stay quiet when there is nothing useful to report.

## Config

```ts
createHeypi({
  state: { root: "./state" },
  // ...adapters, agent, runtime
  jobs: [
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

For file-based apps, jobs can also live under `agent/jobs/` and be loaded by `loadAgent("./agent")`:

```ts
import { defineJob } from "@hunvreus/heypi/authoring";

export default defineJob({
  id: "weekly-ops",
  schedule: { cron: "0 9 * * 1", timezone: "America/Los_Angeles" },
  targets: { slack: { channels: ["C123"] } },
  prompt: "Run the weekly ops review.",
});
```

Top-level `jobs` in `createHeypi()` remains the explicit override. Set `jobs: []` to reconcile and pause configured jobs.

## Options

| Option | Required | Default | Description |
| --- | --- | --- | --- |
| `jobs` | No | omitted | Scheduled job definitions. Set `[]` to disable future runs while reconciling stored jobs as removed. |
| `scheduler.pollMs` | No | `30_000` | How often the scheduler checks for due jobs. |
| `scheduler.lockMs` | No | `600_000` | Lock TTL used while a due job is materialized into queued runs. |
| `scheduler.maxConcurrentRuns` | No | `1` | Maximum queued scheduled targets to execute concurrently. Increase only when the store/runtime can tolerate parallel scheduled turns. |

Job options:

| Option | Required | Default | Description |
| --- | --- | --- | --- |
| `id` | Yes | - | Stable job id, scoped by configured agent id. |
| `kind` | No | `"cron"` | `"cron"` or `"heartbeat"`. |
| `schedule` | No | - | `{ at }`, `{ everyMs }`, or `{ cron, timezone }`. Set implicitly if `everyMs` is provided. |
| `everyMs` | No | - | Shortcut for interval schedules. |
| `idleMs` | No | - | Heartbeat-only idle window for scoped known threads. |
| `targets` | Depends on `kind` | - | Explicit adapter destinations. |
| `scope` | Depends on `kind` | - | Heartbeat filter over known threads. |
| `prompt` | Yes | - | Synthetic message sent into the agent. |
| `state` | No | `"active"` | `"active"` or `"paused"`. |

## Routing

Adapter keys are configured adapter names, not provider kinds. If you configure `slack({ name: "acme", ... })`, use `acme` as the key.

Routing rules:

- `cron` jobs require `targets`.
- `heartbeat` jobs require `scope` or `targets`.
- `targets` and `scope` are mutually exclusive.
- `idleMs` only works with scoped heartbeat jobs.
- `scope` is only for scheduled outbound jobs. It does not restrict inbound chat messages.

Explicit targets can address channels or users:

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
  acme: { channels: ["C123"] },
}
```

## Reliability

Jobs are stored under `(agent, id)`, so two configured agents can reuse the same job id without colliding.

On startup, heypi syncs code-defined jobs for the current agent when `jobs` is configured, including an explicit empty array:

- configured jobs are installed or updated,
- removed jobs are paused,
- manual CLI pause/resume state is preserved unless the job config explicitly sets `state`.

The scheduler records job definitions and queued run attempts in SQLite. Due jobs are materialized into durable `job_run` rows, then worker slots claim queued rows up to `scheduler.maxConcurrentRuns`.

Pausing a job stops future due-run materialization but does not cancel already queued runs. Removing a job from config pauses its stored definition during sync; if a queued run later has no source job row, the run is marked `skipped` with `job removed`.

Each scheduled target gets a stable trace id. A queued or running heartbeat for the same job and stored thread prevents another overlapping heartbeat for that target.

Target failures are recorded as failed `job_run` rows. The job cursor still advances, so delivery failures are visible in history but are not retried automatically by the scheduler.

If the process restarts with a scheduled run marked `running`, startup recovery returns it to the queued state for the scheduler to try again. Delivery is at least once: if the process exits after sending to an adapter but before recording delivery state, the persisted run state may be conservative.

Custom stores that support scheduling must provide `jobs`, `jobRuns`, and `locks`. `jobRuns` must support queued-run claiming and active-target checks. Stores should also implement `transaction()` so job run creation and job cursor updates can commit atomically.

## Not included

Scheduling is not a workflow engine. heypi starts one agent turn with one prompt; the agent may call tools during that turn, but the scheduler does not model separate workflow steps.

Not included:

- editing jobs from chat,
- branching or multi-step workflow orchestration,
- arbitrary pre-run scripts,
- chat-based target discovery,
- automatic retries for failed target delivery.

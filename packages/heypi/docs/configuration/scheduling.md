# Scheduling

Scheduling lets heypi start agent turns without an inbound chat message.

- `cron`: runs at a wall-clock schedule and sends to explicit targets.
- `heartbeat`: runs proactive turns for known chats, optionally only after they have been idle.

A scheduled job creates a normal heypi turn. It uses the same agent, runtime, tools, thread history, and adapter delivery path as a chat message.

Jobs run inside the heypi Node process. Keep the process running for scheduled work to fire.

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

## Options

| Option | Required | Default | Description |
| --- | --- | --- | --- |
| `jobs` | No | `[]` | Scheduled job definitions. |
| `scheduler.pollMs` | No | `30_000` | How often the scheduler checks for due jobs. |
| `scheduler.lockMs` | No | `600_000` | Lock TTL used while a job run is being claimed. |

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

On startup, heypi syncs code-defined jobs for the current agent:

- configured jobs are installed or updated,
- removed jobs are paused,
- manual CLI pause/resume state is preserved unless the job config explicitly sets `state`.

The scheduler records job definitions and run attempts in SQLite. It uses durable locks to avoid duplicate execution and idempotent event IDs for each job target.

Target failures are recorded as failed `job_run` rows. The job cursor still advances, so delivery failures are visible in history but are not retried automatically by the scheduler.

Custom stores that support scheduling must provide `jobs`, `jobRuns`, and `locks`. They should also implement `transaction()` so job run updates and job cursor updates can commit atomically.

## Not included

Scheduling is not a workflow engine. heypi starts one agent turn with one prompt; the agent may call tools during that turn, but the scheduler does not model separate workflow steps.

Not included:

- editing jobs from chat,
- branching or multi-step workflow orchestration,
- arbitrary pre-run scripts,
- chat-based target discovery,
- automatic retries for failed target delivery.

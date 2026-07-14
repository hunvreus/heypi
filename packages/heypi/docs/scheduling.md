# Scheduling plan

Status: proposed, not implemented.

## Goal

Add durable scheduled agent turns to heypi without treating them as inbound chat messages or
building a general workflow engine.

The first version should support:

- One-shot timestamps, fixed intervals, and cron expressions with explicit timezones.
- Turns in an existing conversation or an isolated background session.
- Replies to the active conversation, delivery to another explicit target, or no delivery.
- Persistent schedule state, restart recovery, manual execution, and auditable run history.
- Code-owned schedule definitions through the same typed configuration style as the rest of heypi.

The first version should not include agent heartbeats, arbitrary workflow handlers, scripts, model
overrides, or model-created schedules.

## Reference conclusions

- pi-chat has no scheduling surface. It only queues work from inbound DMs and mentions.
- Eve has a useful minimal declaration: a cron expression plus either a prompt or handler. It also
  gives schedules a trusted application identity and a distinct schedule adapter.
- Hermes has the useful durable lifecycle: one-shot, interval, and cron schedules; persistence;
  pause, resume, manual run, delivery, and run metadata. Its model-facing tool and job definition
  are broader than heypi needs initially.

Use Eve's declaration simplicity and trusted schedule identity. Adopt Hermes's persistence and
recovery behavior incrementally.

## Trigger boundary

`AdapterContext.receive()` means an external message arrived. It applies adapter allow rules,
secret and control-command interception, acknowledgements, attachment materialization, and inbound
message logging.

Scheduled work is trusted application work and must not be forged as a bot-authored
`ChatMessage`. Add a shared internal turn dispatcher below both entry paths:

```text
adapter.receive(message) -> validate external input -> dispatch turn
scheduler fires job      -> create trusted cause    -> dispatch turn
manual app trigger       -> create trusted cause    -> dispatch turn
```

The scheduler may expose the trusted path as `app.trigger()` for manual runs, application hooks,
and tests. This API must require explicit provenance rather than accepting a synthetic user.

```ts
await app.trigger({
	cause: {
		kind: "schedule",
		scheduleId: "monday-digest",
		runId: "run_123",
		scheduledFor: "2026-07-13T09:00:00-07:00",
	},
	prompt: "Prepare the Monday digest.",
	session: {
		kind: "conversation",
		target: {
			adapter: "telegram",
			account: "main",
			conversation: "123456",
		},
	},
	delivery: { kind: "reply" },
});
```

The public name is provisional. The important contract is a trusted non-message entry path with a
typed cause.

## Configuration shape

Schedules belong to `createHeypi()`, not `loadAgent()`: they coordinate application lifecycle,
sessions, and adapters rather than define the agent's model behavior.

```ts
const app = await createHeypi({
	agent,
	adapters: [telegramAdapter],
	schedules: [
		schedule({
			id: "monday-digest",
			when: {
				kind: "cron",
				expression: "0 9 * * 1",
				timezone: "America/Los_Angeles",
			},
			prompt: "Prepare the Monday digest.",
			session: {
				kind: "conversation",
				target: {
					adapter: "telegram",
					account: "main",
					conversation: "123456",
				},
			},
			delivery: { kind: "reply" },
		}),
	],
});
```

`schedule()` should be a typed pass-through with no hidden I/O. Definitions are code-owned and
identified by a required stable ID.

### Schedule

Use a discriminated union instead of parsing one overloaded schedule string:

```ts
type ScheduleWhen =
	| { kind: "at"; at: string }
	| { kind: "every"; interval: string }
	| { kind: "cron"; expression: string; timezone: string };
```

- `at` is an ISO 8601 timestamp. A missing offset is invalid.
- `every` accepts a validated duration such as `30m`, `2h`, or `1d`.
- `cron` initially accepts standard five-field expressions.
- Cron schedules require an IANA timezone; do not silently use the host timezone.

### Session

Execution context and delivery are separate decisions:

```ts
type ScheduleSession =
	| { kind: "conversation"; target: ScheduleTarget }
	| { kind: "isolated"; key?: string };

type ScheduleTarget = {
	adapter: string;
	account: string;
	conversation: string;
	thread?: string;
};
```

- `conversation` uses that conversation's existing Pi session and serialized channel queue.
- `isolated` uses a schedule-owned session with no chat history. An optional stable key allows
  successive runs to share schedule-specific state later; omit it for a fresh run.
- Targets must resolve to one configured adapter. Unknown or ambiguous targets fail at startup.

### Delivery

```ts
type ScheduleDelivery =
	| { kind: "reply" }
	| { kind: "send"; target: ScheduleTarget }
	| { kind: "none" };
```

- `reply` is valid only for a conversation session and uses its adapter target.
- `send` delivers an isolated result to an explicit target without pretending that the target sent
  the scheduled prompt.
- `none` retains the result and run audit without external delivery.

Empty output in `none` mode is a successful silent completion. Do not synthesize `Done.` for
background runs.

## Persistence and lifecycle

Store schedule definitions normalized from code plus runtime state under the agent's heypi state
directory. Keep run records separate from conversation logs.

Each schedule tracks:

- Stable ID and normalized definition hash.
- Enabled state, next scheduled time, and last scheduled time.
- Last run ID, status, start/end timestamps, and error summary.

Each run tracks:

- Run ID, schedule ID, scheduled time, actual start time, and trigger cause.
- `queued`, `running`, `completed`, `failed`, `canceled`, or `skipped` state.
- Associated chat turn ID or isolated session key.
- Delivery target, delivery result, and retained final output.

Persist a run claim before execution with a unique `(scheduleId, scheduledFor)` key. Use atomic
writes and a process lock so overlapping ticks cannot enqueue the same occurrence twice.

Initial lifecycle API:

```ts
await app.schedules.list();
await app.schedules.run("monday-digest");
```

Code remains the source of truth for definitions in the first version. Add persisted create,
update, pause, resume, and remove operations only when a real application needs runtime-managed
schedules. Do not mix code-owned and runtime-owned definitions without an explicit ownership field
and reconciliation policy.

## Timing policies

Use explicit conservative defaults:

- **Misfire:** run once after restart if the latest occurrence is within a bounded grace window;
  otherwise skip it and compute the next occurrence.
- **Overlap:** skip a new occurrence while the same schedule is running.
- **Conversation contention:** queue behind the active turn for that conversation.
- **Isolated contention:** enforce overlap policy by schedule ID.
- **Clock changes:** calculate cron occurrences in the configured timezone and store timestamps in
  UTC with their intended local occurrence available in run metadata.

Expose skipped and recovered occurrences in run history. Do not promise exactly-once side effects;
the durable guarantee is that heypi assigns one run identity per scheduled occurrence and avoids
duplicate local dispatch.

## Audit and events

Do not overload the existing event `origin`, which identifies whether heypi or Pi emitted an event.
Add a separate trigger cause to `ChatJob` and durable records:

```ts
type TurnCause =
	| { kind: "message"; messageId: string; actor: { id: string; name?: string } }
	| {
			kind: "schedule";
			scheduleId: string;
			runId: string;
			scheduledFor: string;
	  }
	| { kind: "manual"; actor?: { id: string; name?: string } };
```

Add schedule lifecycle events independently from Pi turn events:

- `schedule.run.queued`
- `schedule.run.started`
- `schedule.run.completed`
- `schedule.run.failed`
- `schedule.run.skipped`

Conversation runs should record a schedule trigger record in that conversation's audit log, not an
inbound user record. Isolated runs should use a schedule-owned audit surface. Outbound deliveries
remain logged against their destination and link back to the run ID.

## Security

- Scheduled dispatch is trusted host input and bypasses chat allowlists, but target resolution must
  only permit adapters registered on the current app.
- Scheduled prompts do not pass through chat secret or command interception.
- A future model-facing schedule tool must be disabled by default, use the existing approval
  system for mutations, default delivery to the current conversation, and reject arbitrary target
  selection unless explicitly authorized.
- Scheduled runs must not receive schedule-management tools by default, preventing recursive job
  creation.
- Isolated sessions get the normal runtime and tool policy; they are not automatically privileged.

## Implementation order

1. Extract a shared internal turn dispatcher and add typed trigger causes without changing adapter
   behavior.
2. Add `app.trigger()` and tests for message, manual, conversation schedule, and isolated schedule
   audit records.
3. Add schedule definition validation and occurrence calculation.
4. Add persistent run claims, locking, restart recovery, and manual `run()`.
5. Add conversation, isolated, reply, send, and no-delivery execution modes.
6. Add admin schedule listing and run history.
7. Consider runtime-managed schedules and an optional model-facing tool after code-owned schedules
   are proven.

## Deferred heartbeat

Heartbeat should reuse this scheduler and dispatcher, not introduce another timer subsystem. Do not
implement it until its scope is explicit: agent-wide, account-wide, or opt-in per conversation.

An agent-wide heartbeat must define which shared state it can inspect and which trusted destinations
it may notify. It must not fan out over all channels and DMs by default. A conversation heartbeat is
otherwise an interval schedule with conditional no-delivery completion.

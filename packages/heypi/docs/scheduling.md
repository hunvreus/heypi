# Scheduling

Schedules are code-owned cron jobs discovered from `agent/schedules/**/*.ts|js`. They are trusted
application modules, not Pi resources, and are never copied into the staged agent bundle.

Each module default-exports `defineSchedule()` with a five-field cron expression, an explicit IANA
timezone, and exactly one execution form.

## Background prompts

A prompt schedule gets a fresh Pi session for every run. It has a persistent schedule workspace,
but no chat history, chat tools, visible todo, or external delivery. The final assistant text and
session ID are retained in the schedule audit.

```ts
import { defineSchedule } from "@hunvreus/heypi/authoring";

export default defineSchedule({
	cron: "0 9 * * 1",
	timezone: "America/Los_Angeles",
	prompt: "Review the project and prepare the weekly maintenance report.",
});
```

Prompts may live in adjacent files and be loaded with normal TypeScript:

```ts
import { readFileSync } from "node:fs";
import { defineSchedule } from "@hunvreus/heypi/authoring";

const prompt = readFileSync(new URL("./weekly.md", import.meta.url), "utf8");

export default defineSchedule({ cron: "0 9 * * 1", timezone: "UTC", prompt });
```

The resolved prompt is included in the schedule definition hash. List other imported files that can
change handler behavior in `dependencies` so heypi also detects those changes:

```ts
export default defineSchedule({
	cron: "0 9 * * 1",
	timezone: "UTC",
	prompt,
	dependencies: ["./report-options.json"],
});
```

## Conversation dispatch

A handler is trusted application code. It may inspect application state and dispatch one prompt to
a configured adapter conversation. Dispatch accepts the job into that conversation's normal queue
and returns its job ID; it does not wait for the chat turn to finish.

```ts
import { defineSchedule } from "@hunvreus/heypi/authoring";

export default defineSchedule({
	cron: "0 9 * * 1",
	timezone: "America/Los_Angeles",
	async run({ dispatch }) {
		await dispatch({
			prompt: "Post the weekly maintenance summary.",
			target: {
				adapterId: "company-slack",
				conversation: "C0123456789",
			},
		});
	},
});
```

The handler context also contains `scheduleId`, `runId`, `scheduledFor`, `firedAt`, and `signal`.
Handlers may dispatch at most once in the first version.

## Lifecycle

heypi stores definitions and run records under `.heypi/schedules/`. A run occurrence is claimed
before execution. Interrupted claims fail on restart. The latest missed occurrence runs once when it
is less than five minutes old; older occurrences are recorded as skipped. A new occurrence is also
skipped while the same schedule has an active run. Active runs and the latest 100 terminal runs per
schedule are retained.

This is a single-process scheduler. It prevents duplicate dispatch inside one heypi process and
through its persisted occurrence claims; it is not a distributed exactly-once system.

Manual controls are available through the application and admin APIs:

```ts
app.schedules.list();
const claimed = await app.schedules.run("reports/weekly");
app.schedules.runs("reports/weekly");
```

Manual `run()` claims the occurrence and returns immediately. Read `runs()` or the admin API for its
eventual `completed`, `failed`, `canceled`, or `dispatched` state.

- `GET /admin/schedules`
- `POST /admin/schedules/run` with `{ "id": "reports/weekly" }`

Intervals, one-shot jobs, pause/resume, runtime-created schedules, model-facing schedule management,
scripts, model overrides, and workflow graphs are intentionally not included.

# Scheduling

heypi discovers trusted cron modules from `agent/schedules/**/*.ts|js`. Each module default-exports
`defineSchedule()` with a five-field cron expression and an IANA timezone.

## Run a background prompt

```ts
import { defineSchedule } from "@hunvreus/heypi/authoring";

export default defineSchedule({
	cron: "0 9 * * 1",
	timezone: "America/Los_Angeles",
	prompt: "Review the project and prepare the weekly maintenance report.",
});
```

Each run gets a fresh Pi session and a persistent schedule workspace. It has no chat history, chat
tools, visible todo, or external delivery.

Load a longer prompt from an adjacent file when useful:

```ts
import { readFileSync } from "node:fs";
import { defineSchedule } from "@hunvreus/heypi/authoring";

const prompt = readFileSync(new URL("./weekly.md", import.meta.url), "utf8");

export default defineSchedule({
	cron: "0 9 * * 1",
	timezone: "UTC",
	prompt,
	dependencies: ["./weekly.md"],
});
```

Declare every file read by a schedule in `dependencies` so changes become part of its definition
hash.

## Dispatch to chat

A trusted handler may dispatch one prompt into a configured conversation:

```ts
export default defineSchedule({
	cron: "0 9 * * 1",
	timezone: "UTC",
	async run({ dispatch }) {
		await dispatch({
			prompt: "Post the weekly maintenance summary.",
			target: { adapterId: "company-slack", conversation: "C0123456789" },
		});
	},
});
```

Definitions and bounded run history live under `.heypi/schedules`. This is a single-process cron
scheduler, not a distributed workflow engine.

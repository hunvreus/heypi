# Manual setup

Use this when you are adding heypi to an existing app. For a new app, prefer the [Quickstart](index.md).

## Step 1: install heypi

```bash
npm install @hunvreus/heypi
```

## Step 2: create `index.ts`

```ts
import { pathToFileURL } from "node:url";
import { createHeypi, defaultTools, loadAgent, local, runHeypi, slack, workspace } from "@hunvreus/heypi";

const isDev = process.env.HEYPI_DEV === "1";
const adapters = isDev
  ? [local()]
  : [
      slack({
        mode: "socket",
      }),
    ];

const app = createHeypi({
  state: { root: "./state" },
  adapters,
  agent: loadAgent("./agent", { model: "openai/gpt-5.4-mini", tools: defaultTools() }),
  runtime: { name: "just-bash", root: workspace("./workspace") },
});

export default app;

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await runHeypi(app);
}
```

## Step 3: create agent files

```bash
mkdir -p agent/skills agent/tools agent/jobs agent/evals
printf "You are a concise team assistant.\n" > agent/AGENTS.md
printf "Answer directly and accurately.\n" > agent/SOUL.md
```

## Step 4: create `.env`

```bash
OPENAI_API_KEY=
SLACK_BOT_TOKEN=
SLACK_APP_TOKEN=
```

## Step 5: create the Slack app

Use the [Slack setup guide](../adapters/slack.md#setup) to create the app, enable Socket Mode, install it to your workspace, and copy the Slack tokens into `.env`.

## Step 6: run it

```bash
heypi dev
```

Use the printed admin URL or `POST /dev/messages` to test locally without Slack credentials. Use `heypi start` after filling `.env` and installing the Slack app.

## Config notes

- `state.root` stores durable heypi state.
- `local()` registers the loopback dev adapter when `HEYPI_DEV=1`.
- `slack(...)` registers the Slack adapter outside dev mode.
- `loadAgent("./agent", ...)` loads `agent/AGENTS.md`, `agent/SOUL.md`, bundled skills, app tools, jobs, and evals.
- `defaultTools()` adds heypi's built-in runtime tools. Discovery does not add them implicitly.
- `runtime.root` is the workspace for runtime tools, generated files, and scoped runtime state.

# Manual setup

Use this when you are adding heypi to an existing app. For a new app, prefer the [Quickstart](index.md).

## Step 1: install heypi

```bash
npm install @hunvreus/heypi
```

## Step 2: create `index.ts`

```ts
import { createHeypi, loadAgent, slack, workspace } from "@hunvreus/heypi";

export default createHeypi({
  state: { root: "./state" },
  adapters: [
    slack({
      mode: "socket",
    }),
  ],
  agent: loadAgent("./agent", { model: "openai/gpt-5.4-mini" }),
  runtime: { name: "just-bash", root: workspace("./workspace") },
});
```

## Step 3: create agent files

```bash
mkdir -p agent/skills agent/tools agent/jobs evals
printf "You are a concise team assistant. Answer directly and accurately.\n" > agent/instructions.md
```

Optional starter tool:

```ts
// agent/tools/now.ts
import { defineTool } from "@hunvreus/heypi/authoring";
import { z } from "zod";

export default defineTool({
  description: "Return the current ISO timestamp.",
  input: z.object({}),
  run: async () => new Date().toISOString(),
});
```

`loadAgent("./agent", ...)` discovers that file automatically. The app entrypoint keeps using `@hunvreus/heypi`; files under `agent/` use `@hunvreus/heypi/authoring`.

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

Use the printed admin URL or `POST /dev/messages` to test locally. If the Slack adapter is configured for Socket Mode and `.env.local` contains dev bot credentials, `heypi dev` also starts the real Slack adapter.

## Config notes

- `state.root` stores durable heypi state.
- `heypi dev` starts configured adapters, loads `.env` plus `.env.local`, enables admin by default, and adds loopback-only local test routes.
- `heypi start` starts configured adapters, loads `.env`, and does not add admin or local test routes unless configured.
- `loadAgent("./agent", ...)` loads `agent/instructions.md`, default built-in tools, bundled skills, app tools, and jobs.
- `evals/` is discovered by `heypi eval`.
- `runtime.root` is the workspace for runtime tools, generated files, and scoped runtime state.

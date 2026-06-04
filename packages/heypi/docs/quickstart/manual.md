# Manual setup

Use this when you are adding heypi to an existing app. For a new app, prefer the [Quickstart](index.md).

## Step 1: install heypi

```bash
npm install @hunvreus/heypi
```

## Step 2: create `index.ts`

```ts
import { agentFrom, createHeypi, runHeypi, slack, workspace } from "@hunvreus/heypi";

const app = createHeypi({
	state: { root: "./state" },
	adapters: [
		slack({
			botToken: process.env.SLACK_BOT_TOKEN!,
			appToken: process.env.SLACK_APP_TOKEN!,
		}),
	],
	agent: agentFrom("./agent", { model: "openai/gpt-5.4-mini" }),
	runtime: { name: "just-bash", root: workspace("./workspace") },
});

await runHeypi(app);
```

## Step 3: create agent files

```bash
mkdir -p agent/skills tools
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
npm run dev
```

Mention the bot in a test channel.

## Config notes

- `state.root` stores durable heypi state.
- `slack(...)` registers the Slack adapter.
- `agentFrom("./agent", ...)` loads `agent/AGENTS.md`, `agent/SOUL.md`, and bundled skills.
- `runtime.root` is the workspace for runtime tools, generated files, and scoped runtime state.

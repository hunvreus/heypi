# Quickstart

This guide creates a minimal Slack bot with durable state and a scoped runtime workspace.

## Step 1: Install

```bash
npm install @hunvreus/heypi
```

## Step 2: Create the app

Create `index.ts`:

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
	agent: agentFrom("./agent", { model: "openai/gpt-5-mini" }),
	runtime: { root: workspace("./workspace") },
});

await runHeypi(app);
```

What this config does:

- `state.root` is heypi's durable app state directory. In this example it contains the SQLite database for threads, messages, calls, approvals, jobs, and admin data. Other heypi features can also place app-level state there.
- `slack(...)` registers the Slack adapter. In this example it uses Socket Mode, so Slack events arrive over the app-level WebSocket opened with `SLACK_APP_TOKEN`, and replies are sent with `SLACK_BOT_TOKEN`.
- `agentFrom("./agent", ...)` creates the Pi agent. It loads `agent/AGENTS.md` as the main prompt and uses `model` to pick the Pi provider/model, here `openai/gpt-5-mini`.
- `runtime.root` is the workspace for runtime tools. Files written by tools, generated attachments, and scoped runtime state live under this directory instead of being mixed into your app source.
- `OPENAI_API_KEY` is not passed in this config object. The Node process receives it as an environment variable, and Pi's model auth layer reads it when the OpenAI provider is called. See [Agent](../configuration/agent.md#model-credentials).

## Step 3: Add the agent prompt

```bash
mkdir -p agent
echo "You are a concise team assistant." > agent/AGENTS.md
```

## Step 4: Create the Slack app

Use the [Slack setup guide](../adapters/slack.md#setup) to create the app, enable Socket mode, install it to your workspace, and copy:

- `SLACK_BOT_TOKEN`
- `SLACK_APP_TOKEN`

Invite the bot to a test channel.

## Step 5: Check the setup

```bash
npx @hunvreus/heypi check
```

## Step 6: Run it

```bash
OPENAI_API_KEY=... \
SLACK_BOT_TOKEN=xoxb-... \
SLACK_APP_TOKEN=xapp-... \
npx tsx index.ts
```

Mention the bot in the test channel.

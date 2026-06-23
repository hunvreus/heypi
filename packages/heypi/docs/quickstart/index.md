# Quickstart

Use the scaffolder for a new heypi app. Adding heypi to an existing app or want to assemble the files yourself? See [Manual setup](manual.md).

## Step 1: create the app

```bash
npm create heypi@latest my-agent
cd my-agent
```

Other package managers:

```bash
pnpm create heypi@latest my-agent
yarn create heypi my-agent
bun create heypi my-agent
```

The scaffolder asks for adapter, Slack transport when Slack is selected, runtime, model, admin UI, and optional samples. For non-interactive scaffolding, pass `--yes` plus flags such as `--adapter discord`, `--runtime docker`, `--no-admin`, or `--samples`.

Use `--samples` if you want a copyable starter tool under `agent/tools/now.ts` and a smoke eval under `evals/smoke.ts`.

## Step 2: fill in model auth

For the default OpenAI starter, fill this in `.env` before sending local test messages:

```bash
OPENAI_API_KEY=
```

If you selected Anthropic, Gemini, Grok, or another provider, set that provider's env var instead. See [Model credentials](../configuration/agent.md#model-credentials).

Generated apps run `heypi dev` for the first local loop. Dev mode starts configured adapters, loads `.env` plus `.env.local`, enables admin by default, and adds loopback-only local test routes.

For Slack production traffic, use `setup/slack.manifest.json` with the [Slack setup guide](../adapters/slack.md#setup) to create and install the app. Then fill in `SLACK_BOT_TOKEN` and `SLACK_APP_TOKEN`. If you selected HTTP mode, fill in `SLACK_SIGNING_SECRET` instead of `SLACK_APP_TOKEN`.

Other adapters:

- [Discord](../adapters/discord.md)
- [Telegram](../adapters/telegram.md)
- [Webhook](../adapters/webhook.md)

## Step 3: review the generated files

Generated apps are file-first: edit instructions, trusted tools, scheduled jobs, bundled skills, and evals in files. Keep `index.ts` focused on operational wiring such as adapters, runtime, state, and admin.

```text
my-agent/
├─ index.ts
├─ .env
├─ .env.example
├─ agent/
│  ├─ instructions.md
│  ├─ jobs/
│  ├─ skills/
│  └─ tools/
│     └─ now.ts         # with --samples
├─ evals/
│  └─ smoke.ts          # with --samples
└─ setup/
   └─ slack.manifest.json
```

Edit `agent/instructions.md`.

Add custom tools under `agent/tools/` and scheduled jobs under `agent/jobs/`. `loadAgent("./agent")` discovers those files automatically, and file stems become tool names when the module omits `name`.

## Step 4: run it

```bash
npm run dev
```

Open the printed admin URL to send local test messages from Chats. `npm run dev` starts configured adapters and also exposes local testing routes on loopback:

```bash
curl -s http://127.0.0.1:4321/dev/messages \
  -H 'content-type: application/json' \
  -d '{"text":"hello","sync":true}'
```

When the provider app is configured, run the real adapter and mention the bot in a test channel:

```bash
npm run start
```

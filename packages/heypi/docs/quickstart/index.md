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

The scaffolder asks for adapter, Slack transport when Slack is selected, runtime, model, admin UI, and optional samples.

## Step 2: fill in model auth

For the default OpenAI starter, fill this in `.env` before sending local test messages:

```bash
OPENAI_API_KEY=
```

Generated apps start only the loopback local adapter in dev mode, so Slack, Discord, Telegram, or webhook credentials are not required for the first local loop.

For Slack production traffic, use `setup/slack.manifest.json` with the [Slack setup guide](../adapters/slack.md#setup) to create and install the app. Then fill in `SLACK_BOT_TOKEN` and `SLACK_APP_TOKEN`. If you selected HTTP mode, fill in `SLACK_SIGNING_SECRET` instead of `SLACK_APP_TOKEN`.

Other adapters:

- [Discord](../adapters/discord.md)
- [Telegram](../adapters/telegram.md)
- [Webhook](../adapters/webhook.md)

## Step 3: review the generated files

```text
my-agent/
|-- index.ts
|-- .env
|-- .env.example
|-- agent/
|   |-- AGENTS.md
|   |-- SOUL.md
|   |-- evals/
|   |-- jobs/
|   |-- skills/
|   `-- tools/
`-- setup/
    `-- slack.manifest.json
```

Edit `agent/AGENTS.md` and `agent/SOUL.md`.

## Step 4: run it

```bash
npm run dev
```

Open the printed admin URL to send local test messages from Chats. Generated apps start only the loopback local adapter in dev mode, so Slack, Discord, Telegram, or webhook credentials are not required for this first local loop. The dev server also exposes local testing routes on loopback:

```bash
curl -s http://127.0.0.1:3000/dev/messages \
  -H 'content-type: application/json' \
  -d '{"text":"hello","sync":true}'
```

When the provider app is configured, run the real adapter and mention the bot in a test channel:

```bash
npm run start
```

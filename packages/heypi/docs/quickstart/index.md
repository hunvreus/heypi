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

The scaffolder asks for adapter, runtime, model, admin UI, and optional samples.

## Step 2: fill in `.env`

For the default Slack + OpenAI starter:

```bash
OPENAI_API_KEY=
SLACK_BOT_TOKEN=
SLACK_APP_TOKEN=
```

For Slack, use `setup/slack.manifest.json` with the [Slack setup guide](../adapters/slack.md#setup) to create and install the app.

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
|   `-- skills/
|-- tools/
`-- setup/
    `-- slack.manifest.json
```

Edit `agent/AGENTS.md` and `agent/SOUL.md`.

## Step 4: run it

```bash
npm run dev
```

Mention the bot in a test channel.

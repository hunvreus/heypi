# Telegram Workout

Personal fitness coach with Telegram long polling, onboarding, saved profile/plan, daily heartbeat check-ins, and a local Markdown workout log.

The `log_workout` tool appends entries to `examples/telegram-workout/memory/workouts.md`.
The `save_profile` tool writes goals, equipment, schedule, preferences, and constraints to `examples/telegram-workout/memory/profile.md`.

The daily check-in is configured as a heartbeat job. It applies to known Telegram chats after the user has messaged the bot once.

## How It Works

This is the simpler boilerplate example. It shows the normal heypi shape without extra infrastructure tools:

- Telegram long polling adapter.
- `SYSTEM.md` / `AGENTS.md` prompt files.
- Two small custom tools for local Markdown memory.
- A heartbeat job for daily check-ins.
- Optional chat/user allowlists.

Unlike the Slack DevOps example, it does not define remote execution tools, SSH keys, runbooks, or approval-heavy workflows.

## Run

```bash
cp examples/telegram-workout/.env.example examples/telegram-workout/.env
pnpm run dev:telegram
```

Required env vars:

```bash
TELEGRAM_BOT_TOKEN=...
OPENAI_API_KEY=...
```

Optional env vars:

```bash
HEYPI_TELEGRAM_CHATS=
HEYPI_TELEGRAM_USERS=
```

Leave the `HEYPI_TELEGRAM_*` allowlists empty to accept every update Telegram delivers. Set comma-separated IDs to restrict which chats or users may trigger the agent.

This example enables `streaming: true`, so Telegram replies are posted as draft messages and edited while Pi emits text. Delivery pacing and rate-limit retries use heypi's defaults.

Check setup and discover a target chat:

```bash
pnpm heypi telegram check --env examples/telegram-workout/.env
pnpm heypi telegram observe --env examples/telegram-workout/.env
```

Try:

```text
I want to get stronger and lose 10 pounds. I have dumbbells and can train Monday, Wednesday, Friday.
I ran 35 minutes easy today
I skipped legs again this week
Can you review my week?
```

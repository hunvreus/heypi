# Telegram Workout

Personal workout accountability bot with Telegram long polling, daily/weekly workout skills, and a local Markdown workout log.

The `log_workout` tool appends entries to `examples/telegram-workout/memory/workouts.md`.

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

Try:

```text
I ran 35 minutes easy today
I skipped legs again this week
Can you review my week?
```

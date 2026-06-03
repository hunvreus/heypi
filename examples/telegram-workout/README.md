# Telegram Workout

Personal fitness coach with Telegram long polling, onboarding, saved profile/plan, daily heartbeat check-ins, and a local Markdown workout log.

The `log_workout` tool appends entries to `state/memory/workouts.md`.
The `save_profile` tool writes goals, equipment, schedule, preferences, and constraints to `state/memory/profile.md`.
The example sets `state.root: "./state"` and omits `store`, so heypi uses SQLite at `state/heypi.db`.

The daily check-in is configured as a heartbeat job. It applies to known Telegram chats after the user has messaged the bot once.

## How It Works

This is the simpler boilerplate example. It shows the normal heypi shape without extra infrastructure tools:

- Telegram long polling adapter.
- `SOUL.md` / `AGENTS.md` prompt files. `SYSTEM.md` is only for advanced runtime-prompt overrides.
- Default core runtime tools through `coreTools()`.
- Three small custom tools for local Markdown memory: `get_profile`, `save_profile`, and `log_workout`.
- A heartbeat job for daily check-ins.
- Optional chat/user allowlists.

Unlike the Slack DevOps example, it does not define remote execution tools, SSH keys, runbooks, or approval-heavy workflows.

## Run

```bash
cp examples/telegram-workout/.env.example examples/telegram-workout/.env
pnpm run dev:telegram
```

The repo script runs `index.ts` with `examples/telegram-workout` as the working directory.

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

This example enables `streaming: true`. See [`../../packages/heypi/docs/adapters.md`](../../packages/heypi/docs/adapters.md) for shared chat defaults, streaming, approvals, cancel, and busy-thread behavior.

Check setup and discover a target chat:

```bash
pnpm heypi telegram check --env examples/telegram-workout/.env
pnpm heypi telegram observe --env examples/telegram-workout/.env
```

Use `telegram observe` to capture a group chat ID for `HEYPI_TELEGRAM_CHATS`. For a DM-only smoke test, leave the Telegram allowlists empty.

Smoke test from the repo root:

1. Fill `examples/telegram-workout/.env` with `TELEGRAM_BOT_TOKEN` and `OPENAI_API_KEY`.
2. Run `pnpm heypi telegram check --env examples/telegram-workout/.env`.
3. Run `pnpm heypi telegram observe --env examples/telegram-workout/.env`.
4. Send `/start` to the bot in Telegram and confirm `observe` prints the chat.
5. Leave `HEYPI_TELEGRAM_CHATS` empty for the DM test, then run `pnpm run dev:telegram`.
6. Send the bot a DM, for example: `help`.

Try:

```text
I want to get stronger and lose 10 pounds. I have dumbbells and can train Monday, Wednesday, Friday.
I ran 35 minutes easy today
I skipped legs again this week
Can you review my week?
```

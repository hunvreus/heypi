# Discord Gondolin

Discord assistant with a channel-scoped Gondolin VM, memory, skills, secret requests, generated-file attachments, streaming replies, and approval-aware tools.

This is the full runtime example. It is closer to pi-chat than the Slack and Telegram examples, but keeps heypi's service model: runtimes start lazily and stop after idle timeout.

## Requirements

- Node.js 23.6 or newer.
- QEMU installed for Gondolin.
  - macOS: `brew install qemu`
  - Debian/Ubuntu: `sudo apt install qemu-system-arm`
- Internet access on first runtime use so Gondolin can download and cache its guest image.
- A Discord bot with Message Content Intent enabled.

## How It Works

- Discord adapter with mention trigger and streaming replies.
- Top-level `scope: "channel"` so each Discord channel gets its own workspace.
- `@hunvreus/heypi-runtime-gondolin` keeps one warm VM per channel scope.
- Core bash, file, search, history, and attach tools run through the VM-backed runtime.
- `memory: true` enables durable channel memory.
- `skills.enabled` enables scoped channel skills. With `HEYPI_APPROVERS` set, skill writes default to approver-only.
- `secrets` serves a local encrypted handoff page at `http://127.0.0.1:3000/secret`.
- Admin is enabled at `http://127.0.0.1:3000/admin`; use `pnpm exec heypi admin link --state examples/discord-project/state` if you need a fresh login link.

## Run

```bash
cp examples/discord-project/.env.example examples/discord-project/.env
pnpm run dev:discord
```

The repo script runs `index.ts` with `examples/discord-project` as the working directory.

Required env vars:

```bash
DISCORD_BOT_TOKEN=...
OPENAI_API_KEY=...
```

Optional env vars:

```bash
HEYPI_DISCORD_CHANNELS=
HEYPI_DISCORD_USERS=
HEYPI_DISCORD_GROUPS=
HEYPI_APPROVERS=
HEYPI_APPROVER_GROUPS=
```

Leave allowlists empty to accept every event Discord delivers. Guild channel messages need a bot mention with the default trigger.

## Setup Checks

```bash
pnpm exec heypi discord check --env examples/discord-project/.env
pnpm exec heypi discord channels --env examples/discord-project/.env
pnpm exec heypi discord observe --env examples/discord-project/.env
```

Use `discord check` to verify the token and get an invite URL. Use `discord channels` or `discord observe` to find IDs for `HEYPI_DISCORD_CHANNELS`, `HEYPI_DISCORD_USERS`, and `HEYPI_APPROVERS`. Use Discord role IDs for `HEYPI_DISCORD_GROUPS` and `HEYPI_APPROVER_GROUPS`.

Smoke test from the repo root:

1. Fill `examples/discord-project/.env` with `DISCORD_BOT_TOKEN` and `OPENAI_API_KEY`.
2. Run `pnpm exec heypi discord check --env examples/discord-project/.env`.
3. Invite the bot to a server with Guilds, Guild Messages, Direct Messages, and Message Content enabled.
4. Run `pnpm exec heypi discord channels --env examples/discord-project/.env`, then set `HEYPI_DISCORD_CHANNELS` to the channel you want to test.
5. Run `pnpm run dev:discord`.
6. Mention the bot in Discord, for example: `@heypi help`.

Try:

```text
@bot create a status report in report.md and attach it
@bot remember that this channel owns the mobile beta rollout
@bot create a skill for weekly release triage
@bot request a GitHub token so you can inspect a private repo later
@bot run uname -a and tell me where it executed
```

The first runtime command may take longer while Gondolin starts the VM. Subsequent commands in the same channel reuse the warm VM until the 10-minute idle timeout.

Runtime files, memory, skills, and secrets live under `./workspace` with scoped paths. The default SQLite database lives under `./state`.

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
- Core bash, file, search, history, and attach tools run through the VM-backed runtime. Risky bash commands use heypi's default approval policy.
- `memory: true` enables durable channel memory.
- `skills.enabled` enables scoped channel skills. With `HEYPI_DISCORD_APPROVERS` set, skill writes default to approver-only.
- `secrets` uses the hosted encrypted handoff page by default. Set `HEYPI_SECRET_URL` with a fixed `HEYPI_HTTP_PORT` to self-host it locally.
- Admin is enabled on the shared local HTTP listener. `HEYPI_HTTP_PORT=0` asks the OS for a free port, and heypi logs the admin URL at startup. Use `pnpm exec heypi admin link` from this example folder if you need a fresh login link.

## Run

```bash
cd examples/discord-gondolin
cp .env.example .env
pnpm dev
```

Required env vars:

```bash
DISCORD_BOT_TOKEN=...
OPENAI_API_KEY=...
```

Optional env vars:

```bash
DISCORD_CLIENT_ID=
HEYPI_DISCORD_CHANNELS=
HEYPI_DISCORD_USERS=
HEYPI_DISCORD_GROUPS=
HEYPI_DISCORD_APPROVERS=
HEYPI_DISCORD_APPROVER_GROUPS=
HEYPI_DISCORD_ADMINS=
HEYPI_DISCORD_ADMIN_GROUPS=
HEYPI_HTTP_PORT=0
# HEYPI_SECRET_URL=http://127.0.0.1:3000/secret
```

Leave allowlists empty to accept every event Discord delivers. Set `HEYPI_DISCORD_USERS` or `HEYPI_DISCORD_GROUPS` to restrict who can use the bot, and set `HEYPI_DISCORD_APPROVERS` or `HEYPI_DISCORD_ADMINS` for risky actions. Guild channel messages need a bot mention with the default trigger.
Set `DISCORD_CLIENT_ID` to register native slash commands such as `/status`, `/approvals`, and `/bypasses` at startup.

## Setup Checks

```bash
pnpm exec heypi discord invite --client-id "$DISCORD_CLIENT_ID"
pnpm exec heypi discord check
pnpm exec heypi discord channels engineering
pnpm exec heypi discord observe
```

Use `discord invite` to install the bot with the required OAuth scopes and permissions. Use `discord check` to verify the token. Use `discord channels [query]` to find channel IDs. Use Discord Developer Mode or `discord observe` to find user IDs for `HEYPI_DISCORD_USERS`, `HEYPI_DISCORD_APPROVERS`, and `HEYPI_DISCORD_ADMINS`. Use Discord role IDs for `HEYPI_DISCORD_GROUPS`, `HEYPI_DISCORD_APPROVER_GROUPS`, and `HEYPI_DISCORD_ADMIN_GROUPS`. Admins inherit approver permissions.

Smoke test:

1. Fill `.env` with `DISCORD_BOT_TOKEN` and `OPENAI_API_KEY`.
2. Set `DISCORD_CLIENT_ID`, then run `pnpm exec heypi discord invite --client-id "$DISCORD_CLIENT_ID"` and open the printed URL.
3. Run `pnpm exec heypi discord check`.
4. Run `pnpm exec heypi discord channels <channel-name>`, then set `HEYPI_DISCORD_CHANNELS` to the channel you want to test.
5. Copy your Discord user ID from Developer Mode, or run `pnpm exec heypi discord observe` and send a test message. Optionally set `HEYPI_DISCORD_USERS` and `HEYPI_DISCORD_APPROVERS` to your user ID.
6. Run `pnpm dev`.
7. Mention the bot in Discord, for example: `@heypi help`.

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

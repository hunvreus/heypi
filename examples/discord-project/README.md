# Discord Project

Team project assistant with Discord gateway events, streaming replies, core runtime tools, and one approval-gated custom tool.

This is the middle-sized example: more realistic than Telegram, much smaller than Slack DevOps.

## How It Works

- Discord adapter with mention trigger.
- `SOUL.md` / `AGENTS.md` prompt files.
- Default core runtime tools through `coreTools()`.
- `project_note`: appends a project note to local Markdown.
- `set_project_status`: approval-gated status updates with structured approval details.
- Optional guild/channel/user allowlists and approval approvers.

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
HEYPI_DISCORD_GUILDS=
HEYPI_DISCORD_CHANNELS=
HEYPI_DISCORD_USERS=
HEYPI_APPROVERS=
```

Leave allowlists empty to accept every event Discord delivers. Guild channel messages need a bot mention with the default trigger.

Check setup and discover IDs:

```bash
pnpm heypi discord check --env examples/discord-project/.env
pnpm heypi discord channels --env examples/discord-project/.env
pnpm heypi discord observe --env examples/discord-project/.env
```

Use `discord check` to verify the token and get an invite URL. Use `discord channels` or `discord observe` to find IDs for `HEYPI_DISCORD_GUILDS`, `HEYPI_DISCORD_CHANNELS`, `HEYPI_DISCORD_USERS`, and `HEYPI_APPROVERS`.

Smoke test from the repo root:

1. Fill `examples/discord-project/.env` with `DISCORD_BOT_TOKEN` and `OPENAI_API_KEY`.
2. Run `pnpm heypi discord check --env examples/discord-project/.env`.
3. Invite the bot to a server with Guilds, Guild Messages, Direct Messages, and Message Content enabled.
4. Run `pnpm heypi discord channels --env examples/discord-project/.env`, then set `HEYPI_DISCORD_CHANNELS` to the channel you want to test.
5. Run `pnpm run dev:discord`.
6. Mention the bot in Discord, for example: `@heypi help`.

Try:

```text
@bot note that frontend polish is blocking the beta
@bot set the mobile-beta status to blocked because design QA found layout regressions
@bot summarize current project notes
```

The status update should render a Discord approval card with Project, Status, and Reason details.

Project notes and the default SQLite database live under the explicit example state root, `./state`.

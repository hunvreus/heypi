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

Try:

```text
@bot note that frontend polish is blocking the beta
@bot set the mobile-beta status to blocked because design QA found layout regressions
@bot summarize current project notes
```

The status update should render a Discord approval card with Project, Status, and Reason details.

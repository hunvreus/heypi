# CLI

The `heypi` CLI is shipped with `@hunvreus/heypi`. Use it for setup checks, provider discovery, database migrations, admin links, approvals, and scheduled jobs.

Run the local project binary with `pnpm exec heypi <command>` or `npm exec heypi -- <command>`. Without a local install, use `npx @hunvreus/heypi <command>`.

Most provider commands load `./.env` when it exists. Pass `--env <path>` to load another env file. Database commands need `--db`; with the default store, use `<state.root>/heypi.db`.

## Commands

### General

| Command | What it does |
| --- | --- |
| `heypi help` | Prints CLI help. |
| `heypi version` | Prints the installed heypi version. |
| `heypi check [--env .env] [--db ./state/heypi.db] [--runtime-root ./workspace]` | Checks local env, database access, migrations, and runtime root setup. |

### Database

| Command | What it does |
| --- | --- |
| `heypi db check --db ./state/heypi.db` | Checks whether a database is reachable and migrated. |
| `heypi db migrate --db ./state/heypi.db` | Applies shipped SQL migrations. Migration hashes are checked so edited migrations fail instead of replaying. |

### Slack

| Command | What it does |
| --- | --- |
| `heypi slack check [--env .env]` | Verifies Slack credentials and prints workspace/team plus bot identity. |
| `heypi slack manifest [--url https://host/slack/slack/events]` | Prints a starter Slack manifest for HTTP mode. |
| `heypi slack channels [--env .env] [--private]` | Lists Slack channel IDs visible to the bot and prints target snippets. |
| `heypi slack env` | Prints expected Slack environment variables. |

### Telegram

| Command | What it does |
| --- | --- |
| `heypi telegram check [--env .env]` | Verifies Telegram bot credentials. |
| `heypi telegram observe [--env .env] [--timeout 60]` | Waits for a delivered Telegram message and prints chat IDs plus target snippets. |

### Discord

| Command | What it does |
| --- | --- |
| `heypi discord check [--env .env]` | Verifies Discord bot credentials. |
| `heypi discord observe [--env .env] [--timeout 60]` | Waits for a delivered Discord message and prints guild, channel, and user IDs plus target snippets. |
| `heypi discord channels [--env .env]` | Lists Discord text channels visible to the bot. |
| `heypi discord invite --client-id <application-id>` | Prints a Discord install URL. Uses `DISCORD_CLIENT_ID` when `--client-id` is omitted. |
| `heypi discord env` | Prints expected Discord environment variables. |

### Admin

| Command | What it does |
| --- | --- |
| `heypi admin link [--state ./state] [--url http://127.0.0.1:3000] [--pid <pid>] [--json]` | Mints a fresh one-time admin login URL from local admin state. Use `--pid` when multiple admin descriptors exist. |

### Approvals

| Command | What it does |
| --- | --- |
| `heypi approvals list --db ./state/heypi.db [--json]` | Lists pending approvals. Read-only. |
| `heypi approvals show <id> --db ./state/heypi.db [--json]` | Shows one approval. Read-only. |

### Jobs

| Command | What it does |
| --- | --- |
| `heypi jobs list --db ./state/heypi.db [--agent <id>] [--json]` | Lists stored jobs. Jobs are scoped by agent. |
| `heypi jobs show <id> --db ./state/heypi.db [--agent <id>] [--json]` | Shows one stored job. |
| `heypi jobs run <id> --db ./state/heypi.db [--agent <id>]` | Marks a job due now. A running app executes it on the next scheduler tick. |
| `heypi jobs pause <id> --db ./state/heypi.db [--agent <id>]` | Pauses a stored job. |
| `heypi jobs resume <id> --db ./state/heypi.db [--agent <id>]` | Resumes a stored job. |

## Notes

- `admin link` signs the login URL locally from `<state.root>/admin` state or `HEYPI_ADMIN_SECRET`; it does not ask the running server to mint a token.
- Approval commands are read-only. Approve or reject from the original chat provider so the audit trail records the provider actor.
- `jobs run` does not execute the job inside the CLI process. Execution needs the running app's agent, adapters, runtime, and tools.

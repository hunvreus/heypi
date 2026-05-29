# CLI

The `heypi` CLI is a separate executable shipped with the npm package. It does not run in production unless you invoke it.

Use it for setup checks, provider diagnostics, database migrations, and scheduled job inspection.

Most provider commands load `./.env` when it exists. Pass `--env <path>` to load a different file. You can pass tokens directly with command-specific flags, but env files keep setup checks aligned with the app you are about to run.

Apps must set `state.root`. When they omit `store`, heypi uses the default SQLite database at `<state.root>/heypi.db`. Offline CLI commands that inspect or migrate the database still need `--db`; from the app folder, pass that default path explicitly as `--db ./state/heypi.db`.

## Commands

```bash
heypi check [--env .env] [--db ./state/heypi.db] [--runtime-root ./workspace]
heypi db check --db ./state/heypi.db
heypi db migrate --db ./state/heypi.db
```

Slack:

```bash
heypi slack check [--env .env]
heypi slack manifest [--url https://host/slack/slack/events]
heypi slack channels [--env .env] [--private]
heypi slack env
```

Telegram:

```bash
heypi telegram check [--env .env]
heypi telegram observe [--env .env] [--timeout 60]
```

Discord:

```bash
heypi discord check [--env .env]
heypi discord observe [--env .env] [--timeout 60]
heypi discord channels [--env .env]
heypi discord invite --client-id <application-id>
heypi discord env
```

Provider discovery commands print IDs needed in config:

- `telegram observe`: waits for a delivered Telegram message and prints the chat id plus a `targets` snippet for jobs.
- `slack channels`: lists Slack channel IDs visible to the bot and prints a `targets` snippet. Use `--private` for private channels after adding the required Slack scope.
- `discord channels`: lists guild/channel IDs for text channels visible to the bot.
- `discord observe`: waits for a delivered Discord message and prints guild, channel, and user IDs plus a `targets` snippet.
- `slack check`: validates Slack credentials and prints the workspace/team and bot identity.

Admin:

```bash
heypi admin link [--state ./state] [--url http://127.0.0.1:3000] [--pid <pid>] [--json]
```

`admin link` mints a fresh one-time login URL from local admin state. The app writes `<state.root>/admin/server.<pid>.json` after the HTTP listener starts. When no manual `admin.secret` is configured, it also stores generated signing material at `<state.root>/admin/secret`. The CLI uses `HEYPI_ADMIN_SECRET` when set, otherwise it reads the state secret and signs a short-lived canonical-state-root-scoped login URL locally; it does not ask the running server to mint or store tokens. Descriptor-selected links are probed against the admin instance id before printing. `--url` overrides the descriptor URL, but the CLI still probes that URL against the descriptor instance id and still requires `--state` or discoverable local admin state for token scope. Use `--pid` when selecting one descriptor from multiple live instances. If no admin state is discoverable from the current directory, pass `--state`.

Approvals:

```bash
heypi approvals list --db ./state/heypi.db [--json]
heypi approvals show <id> --db ./state/heypi.db [--json]
```

Approval CLI commands are read-only. Approve or reject from the original chat provider so the audit trail records the provider actor that made the decision.

Jobs:

```bash
heypi jobs list --db ./state/heypi.db [--agent <id>] [--json]
heypi jobs show <id> --db ./state/heypi.db [--agent <id>] [--json]
heypi jobs run <id> --db ./state/heypi.db [--agent <id>]
heypi jobs pause <id> --db ./state/heypi.db [--agent <id>]
heypi jobs resume <id> --db ./state/heypi.db [--agent <id>]
```

Job commands are scheduler admin commands. Jobs are scoped by agent. Use `--agent` when a DB contains more than one agent or when mutating a job. `jobs run` marks the job due now. A running heypi app executes it on its next scheduler tick because execution needs the app's agent, adapters, runtime, and tools.

## Install

Project dependency:

```bash
pnpm add @hunvreus/heypi
pnpm exec heypi check
```

Without installing globally:

```bash
npx @hunvreus/heypi check
```

## Package Dry Run

Before publishing:

```bash
pnpm run check
pnpm run typecheck
pnpm run test
pnpm run pack:dry
```

## Migrations

`heypi db migrate` applies the SQL files shipped in the package. Applied migration hashes are recorded in the database; if a migration file changes after it was applied, migration fails instead of replaying it. The repo currently carries one generated baseline, `drizzle/0000_baseline.sql`, with matching `drizzle/meta/` metadata. After release, treat applied migration files as immutable and generate new migration files with Drizzle's statement breakpoints instead of editing the baseline.

# CLI

The `heypi` CLI is a separate executable shipped with the npm package. It does not run in production unless you invoke it.

Use it for setup checks, provider diagnostics, database migrations, and scheduled job inspection.

## Commands

```bash
heypi check [--env .env] [--db heypi.db] [--runtime-root ./workspace]
heypi db check --db heypi.db
heypi db migrate --db heypi.db
```

Slack:

```bash
heypi slack check [--env .env]
heypi slack manifest [--url https://host/slack/events]
heypi slack env
```

Telegram:

```bash
heypi telegram check [--env .env]
heypi telegram observe [--env .env] [--timeout 60]
```

Jobs:

```bash
heypi jobs list --db heypi.db [--json]
heypi jobs run <id> --db heypi.db
heypi jobs pause <id> --db heypi.db
heypi jobs resume <id> --db heypi.db
```

`jobs run` marks the job due now. A running heypi app executes it on its next scheduler tick because execution needs the app's agent, adapters, runtime, and tools.

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

`heypi db migrate` applies the SQL files shipped in the package. Applied migration hashes are recorded in the database; if a migration file changes after it was applied, migration fails instead of replaying it. The initial `drizzle/0000_*.sql` file is the baseline and should be treated as immutable after release. Future schema changes should be generated as new migration files with Drizzle's statement breakpoints, not by editing the baseline.

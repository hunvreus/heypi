# CLI

The `heypi` CLI ships with `@hunvreus/heypi`. Use it to check local setup, discover chat provider IDs, migrate the SQLite store, mint admin links, inspect approvals, and control scheduled jobs.

## Entrypoint

```bash
pnpm exec heypi <command>
npm exec heypi -- <command>
npx @hunvreus/heypi <command>
```

Create a new app with:

```bash
npm create heypi@latest
```

Most provider commands load `./.env` when it exists. Pass `--env <path>` to load another file. Database commands require `--db`; with the default store, use `<state.root>/heypi.db`.

Explicit token flags win over environment variables. `--json` is available on admin links, approvals, and jobs where machine-readable output is useful. Provider token values are not echoed in CLI error output.

## Command index

| Command | Use for |
| --- | --- |
| [`heypi init`](#heypi-init) | Print app scaffolding commands. |
| [`heypi check`](#heypi-check) | Validate Node, env, database, and runtime paths. |
| [`heypi db`](#heypi-db) | Check or migrate the SQLite store. |
| [`heypi slack`](#heypi-slack) | Verify Slack auth, generate manifests, and discover channels. |
| [`heypi telegram`](#heypi-telegram) | Verify Telegram auth and discover chat IDs from delivered messages. |
| [`heypi discord`](#heypi-discord) | Verify Discord auth, generate invite URLs, and discover channels. |
| [`heypi admin`](#heypi-admin) | Mint local admin login links. |
| [`heypi approvals`](#heypi-approvals) | Inspect pending approval requests. |
| [`heypi jobs`](#heypi-jobs) | Inspect and change scheduled jobs. |
| [`heypi help`](#help-and-version) | Print CLI help. |
| [`heypi version`](#help-and-version) | Print the installed package version. |

## heypi init

```bash
heypi init
```

Prints the recommended app creation commands:

```bash
npm create heypi@latest
npm create heypi@latest my-agent -- --yes
```

## heypi check

```bash
heypi check [--env .env] [--db ./state/heypi.db] [--runtime-root ./workspace]
```

Runs local setup checks. Without optional flags, it checks Node and `OPENAI_API_KEY`. Add `--db` to verify database access and migrations. Add `--runtime-root` to verify the runtime workspace directory exists.

| Option | Description |
| --- | --- |
| `--env <path>` | Load an env file before checking. Defaults to `./.env` when present. |
| `--db <path>` | Open the SQLite database and apply/check migrations. |
| `--runtime-root <path>` | Check that the runtime workspace directory exists. |

Example:

```bash
npx @hunvreus/heypi check --env .env --db ./state/heypi.db --runtime-root ./workspace
```

## heypi db

```bash
heypi db check --db ./state/heypi.db
heypi db migrate --db ./state/heypi.db
```

| Subcommand | Description |
| --- | --- |
| `check` | Opens the database and verifies migrations. |
| `migrate` | Applies shipped SQL migrations. Edited migration hashes fail instead of replaying silently. |

| Option | Description |
| --- | --- |
| `--db <path>` | Required SQLite database path. |

Run migrations during deploy before starting the app:

```bash
npx @hunvreus/heypi db migrate --db ./state/heypi.db
```

## heypi slack

```bash
heypi slack check [--env .env] [--bot-token <token>] [--app-token <token>] [--signing-secret <secret>]
heypi slack manifest [--url https://host/slack/slack/events]
heypi slack channels [--env .env] [--bot-token <token>] [--private]
heypi slack env
```

| Subcommand | Description |
| --- | --- |
| `check` | Verifies Slack bot auth and reports Socket Mode and HTTP secret presence. |
| `manifest` | Prints a starter HTTP-mode Slack app manifest. |
| `channels` | Lists visible Slack channel IDs and prints `targets` snippets. |
| `env` | Prints expected Slack environment variables. |

| Option | Applies to | Description |
| --- | --- | --- |
| `--env <path>` | `check`, `channels` | Load env file. |
| `--bot-token <token>` | `check`, `channels` | Use instead of `SLACK_BOT_TOKEN`. |
| `--app-token <token>` | `check` | Use instead of `SLACK_APP_TOKEN`. Needed only for Socket Mode. |
| `--signing-secret <secret>` | `check` | Use instead of `SLACK_SIGNING_SECRET`. Needed only for HTTP mode. |
| `--url <url>` | `manifest` | Event and interactivity request URL. |
| `--private` | `channels` | Include private channels visible to the bot. |

Examples:

```bash
npx @hunvreus/heypi slack manifest --url https://agent.example.com/slack/slack/events
npx @hunvreus/heypi slack channels --env .env --private
```

## heypi telegram

```bash
heypi telegram check [--env .env] [--token <token>]
heypi telegram observe [--env .env] [--token <token>] [--timeout 60]
```

| Subcommand | Description |
| --- | --- |
| `check` | Verifies Telegram bot credentials with `getMe`. |
| `observe` | Waits for a delivered message and prints chat IDs plus `targets` snippets. |

| Option | Description |
| --- | --- |
| `--env <path>` | Load env file. |
| `--token <token>` | Use instead of `TELEGRAM_BOT_TOKEN`. |
| `--timeout <seconds>` | Wait time for `observe`. Defaults to `60`. |

Telegram cannot enumerate chats. Send `/start` to the bot, or post in the target group/channel, then run:

```bash
npx @hunvreus/heypi telegram observe --env .env
```

`observe` deletes any active webhook for the token before polling. Do not run it next to another long-polling process for the same bot.

## heypi discord

```bash
heypi discord check [--env .env] [--token <token>]
heypi discord observe [--env .env] [--token <token>] [--timeout 60]
heypi discord channels [--env .env] [--token <token>]
heypi discord invite [--client-id <application-id>]
heypi discord env
```

| Subcommand | Description |
| --- | --- |
| `check` | Verifies Discord bot credentials and prints an invite URL. |
| `observe` | Waits for a delivered message and prints guild, channel, user, and `targets` snippets. |
| `channels` | Lists Discord text channels visible to the bot. |
| `invite` | Prints a Discord install URL. Uses `DISCORD_CLIENT_ID` when `--client-id` is omitted. |
| `env` | Prints expected Discord environment variables. |

| Option | Applies to | Description |
| --- | --- | --- |
| `--env <path>` | `check`, `observe`, `channels` | Load env file. |
| `--token <token>` | `check`, `observe`, `channels` | Use instead of `DISCORD_BOT_TOKEN`. |
| `--client-id <id>` | `invite` | Use instead of `DISCORD_CLIENT_ID`. |
| `--timeout <seconds>` | `observe` | Wait time. Defaults to `60`. |

Examples:

```bash
npx @hunvreus/heypi discord invite --client-id <application-id>
npx @hunvreus/heypi discord observe --env .env
```

## heypi admin

```bash
heypi admin link [--env .env] [--state ./state] [--url http://127.0.0.1:3000] [--pid <pid>] [--json]
```

Mints a short-lived one-time admin login URL from local admin state.

| Option | Description |
| --- | --- |
| `--env <path>` | Load env file. |
| `--state <path>` | heypi state root. Defaults to `HEYPI_STATE_ROOT`, local `./state`, or one discovered local state root. |
| `--url <url>` | Admin base URL. Defaults to `HEYPI_ADMIN_URL` or the live admin server descriptor. |
| `--pid <pid>` | Select one running admin server when multiple descriptors exist. |
| `--json` | Print `{ url, expiresAt }`. |

`admin link` signs the login URL locally from `<state.root>/admin` state or `HEYPI_ADMIN_SECRET`. It does not ask the running server to mint a token.

Example:

```bash
npx @hunvreus/heypi admin link --state ./state --url https://agent.example.com
```

## heypi approvals

```bash
heypi approvals list --db ./state/heypi.db [--limit 25] [--json]
heypi approvals show <id> --db ./state/heypi.db [--json]
```

Approval commands are read-only. Approve or reject from the original chat provider so the audit trail records the provider actor.

| Subcommand | Description |
| --- | --- |
| `list` | Lists pending approvals. |
| `show <id>` | Shows one approval. |

| Option | Applies to | Description |
| --- | --- | --- |
| `--db <path>` | All | Required SQLite database path. |
| `--limit <count>` | `list` | Maximum rows. Defaults to `25`. |
| `--json` | All | Print raw JSON. |

## heypi jobs

```bash
heypi jobs list --db ./state/heypi.db [--agent <id>] [--limit 100] [--json]
heypi jobs show <id> --db ./state/heypi.db [--agent <id>] [--json]
heypi jobs run <id> --db ./state/heypi.db [--agent <id>]
heypi jobs pause <id> --db ./state/heypi.db [--agent <id>]
heypi jobs resume <id> --db ./state/heypi.db [--agent <id>]
```

| Subcommand | Description |
| --- | --- |
| `list` | Lists stored jobs, including last-run state when available. |
| `show <id>` | Shows one stored job and its last run. |
| `run <id>` | Marks a job due now. |
| `pause <id>` | Sets a job state to `paused`. |
| `resume <id>` | Sets a job state to `active`. |

| Option | Applies to | Description |
| --- | --- | --- |
| `--db <path>` | All | Required SQLite database path. |
| `--agent <id>` | All | Filter or mutate jobs for one agent. |
| `--limit <count>` | `list` | Maximum rows. Defaults to `100`. |
| `--json` | `list`, `show` | Print raw JSON. |

`jobs run` does not execute the job inside the CLI process. It only moves `nextAt` to now; a running heypi app executes the job on the next scheduler tick.

Example:

```bash
npx @hunvreus/heypi jobs run daily-report --db ./state/heypi.db --agent ops
```

## Help and version

```bash
heypi help
heypi version
```

`help` prints CLI usage. `version` prints the installed `@hunvreus/heypi` package version.

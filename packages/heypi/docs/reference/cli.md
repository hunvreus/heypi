# CLI

The `heypi` CLI ships with `@hunvreus/heypi`. Use it to diagnose project setup, discover chat provider IDs, migrate the SQLite store, mint admin links, inspect approvals, and control scheduled jobs.

## Entrypoint

Examples use `heypi`. If it is not on `PATH`, run it through your package manager:

```bash
pnpm exec heypi <command>
npm exec heypi -- <command>
npx @hunvreus/heypi <command>
```

Create a new app with:

```bash
npm create heypi@latest
```

Most commands load `./.env` when it exists. `heypi dev` also loads `./.env.local` after `./.env`, so local overrides win while shell environment variables still take precedence. Pass `--env <path>` to load one explicit file instead. Database commands require `--db`; with the default store, use `<state.root>/heypi.db`.

Explicit token flags win over environment variables. `--json` is available on admin links, approvals, and jobs where machine-readable output is useful. Provider token values are not echoed in CLI error output.

## Command index

| Command | Use for |
| --- | --- |
| [`heypi init`](#heypi-init) | Print app scaffolding commands. |
| [`heypi dev`](#heypi-dev) | Start an exported app for local development. |
| [`heypi start`](#heypi-start) | Start an exported app for normal runtime. |
| [`heypi doctor`](#heypi-doctor) | Run static project diagnostics, with optional boot checks. |
| [`heypi status`](#heypi-status) | Inspect persisted app status for operators. |
| [`heypi threads`](#heypi-threads) | List and search persisted threads. |
| [`heypi thread`](#heypi-thread) | Show one persisted thread transcript. |
| [`heypi events`](#heypi-events) | Show typed trace events. |
| [`heypi db`](#heypi-db) | Check or migrate the SQLite store. |
| [`heypi slack`](#heypi-slack) | Verify Slack auth, generate manifests, and discover channels/users. |
| [`heypi telegram`](#heypi-telegram) | Verify Telegram auth and discover chat IDs from delivered messages. |
| [`heypi discord`](#heypi-discord) | Verify Discord auth, generate invite URLs, and discover channels. |
| [`heypi admin`](#heypi-admin) | Mint local admin login links. |
| [`heypi approvals`](#heypi-approvals) | Inspect pending approval requests and active approval bypasses. |
| [`heypi jobs`](#heypi-jobs) | Inspect and change scheduled jobs. |
| [`heypi eval`](#heypi-eval) | Inspect and validate authored eval definitions. |
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

## heypi dev

```bash
heypi dev [index.ts] [--env .env]
```

Loads `./.env`, then `./.env.local`, loads the app module with `tsx`, and starts the default export from `createHeypi(...)`. Dev mode starts the configured adapters exactly as declared, enables admin by default when `admin` is omitted, and appends the loopback-only `local()` adapter for scripted local messages. If the admin HTTP host is not loopback, dev mode fails rather than exposing `/dev/messages` on a public listener.

When the admin panel is enabled, dev mode prints its URL after startup. Passwordless loopback dev admins print `/admin` directly; authenticated admins print a short-lived login link. This uses the actual bound admin HTTP port, including `admin: { http: { port: 0 } }`.

The admin Chats view includes a compose box for sending local dev messages through the same handler path used by adapters. Thread detail pages show messages, model lifecycle events, calls, approvals, and typed trace events.

If heypi restarts mid-turn, startup recovery marks interrupted turns and calls failed and records recovery events in the trace timeline. This is inspection and cleanup, not exact workflow replay.

Dev mode registers these loopback-only routes. When heypi can discover the running admin HTTP listener, it prints an absolute `/dev/messages` URL using the actual bound port.

```bash
POST /dev/messages
POST /dev/threads/:threadId/messages
GET /dev/threads/:threadId/runs/:runId
```

Example:

```bash
curl -s http://127.0.0.1:4321/dev/messages \
  -H 'content-type: application/json' \
  -d '{"text":"hello","sync":true}'
```

## heypi threads

```bash
heypi threads --db ./state/heypi.db [--agent <id>] [--provider <name>] [--q <text>] [--limit 25] [--offset 0] [--json]
```

Lists persisted threads from the SQLite store. Use `--q` to search thread metadata and recent message text.

## heypi thread

```bash
heypi thread <id> --db ./state/heypi.db [--agent <id>] [--limit 100] [--json]
```

Shows one persisted thread transcript plus approvals attached to that thread. This is read-only and can run against a stopped app.

## heypi events

```bash
heypi events --db ./state/heypi.db [--agent <id>] [--thread <id>] [--trace <id>] [--limit 100] [--json]
```

Shows typed trace events for debugging messages, turns, tools, approvals, jobs, recovery, and eval runs.

## heypi start

```bash
heypi start [index.ts] [--env .env]
```

Loads `./.env`, loads the app module with `tsx`, and starts the default export from `createHeypi(...)` with the configured adapters. Start mode does not enable admin or local test routes unless the app config explicitly does so.

For custom Node deployment entrypoints, import the same app declaration and call `runHeypi(app)`:

```ts
import { runHeypi } from "@hunvreus/heypi";
import app from "./index.js";

await runHeypi(app);
```

## heypi doctor

```bash
heypi doctor [--root .] [--json]
heypi doctor --boot [--env .env] [--db ./state/heypi.db] [--runtime-root ./workspace] [--json]
```

Runs setup diagnostics. By default, `doctor` is static and does not import your app entrypoint or authored tool modules. Use `--boot` when you also want runtime setup checks for Node, database access, migrations, runtime workspace paths, and the current OpenAI env check. Non-OpenAI model credentials are not provider-validated by `doctor` yet; set the env var for your selected provider from the [Agent](../configuration/agent.md#model-credentials) page.

Static diagnostics include:

- default entrypoint discovery,
- `loadAgent()` vs obsolete `agentFrom()` hints,
- current `agent/instructions.md`, `agent/tools/`, `agent/jobs/`, and `evals/` layout checks,
- stale `AGENTS.md`, `SOUL.md`, `SYSTEM.md`, root `tools/`, and root `jobs/` warnings,
- duplicate discovered tool, job, and eval filename checks,
- `.env.example` coverage for statically referenced `process.env.KEY` variables,
- inferred built-in adapters and runtime package references from the entrypoint text.

| Option | Description |
| --- | --- |
| `--root <path>` | Project root to scan. Defaults to the invocation root. |
| `--boot` | Also run boot-time setup checks. This still does not import the app, but it reads env, opens the database when `--db` is passed, and checks runtime paths. |
| `--env <path>` | Load an env file before boot checks. Defaults to `./.env` when present. |
| `--db <path>` | Open the SQLite database and apply/check migrations during `--boot`. |
| `--runtime-root <path>` | Check that the runtime workspace directory exists during `--boot`. |
| `--json` | Print machine-readable diagnostics. |

Example:

```bash
heypi doctor
heypi doctor --boot --env .env --db ./state/heypi.db --runtime-root ./workspace
```

## heypi status

```bash
heypi status --db ./state/heypi.db [--agent default] [--runtime-root ./workspace] [--json]
```

Inspects persisted operator state for one agent. It opens the database without applying migrations. If shipped migrations are pending, it warns and asks you to run `heypi db migrate` before querying status. When migrations are current, it optionally checks the runtime root and reports the app lock, running turns, running and approval-blocked calls, pending approvals, active bypasses, and scheduled jobs. It does not inspect in-memory adapter connections or queue depth from a stopped CLI process.

| Option | Description |
| --- | --- |
| `--db <path>` | Required SQLite database path. |
| `--agent <id>` | Agent to inspect. Defaults to `default`. |
| `--runtime-root <path>` | Check that the runtime workspace directory exists. |
| `--json` | Print machine-readable output. |

## heypi db

```bash
heypi db check --db ./state/heypi.db
heypi db migrate --db ./state/heypi.db
```

## heypi eval

```bash
heypi eval list [--evals ./evals] [--tag smoke] [--json]
heypi eval show <name> [--evals ./evals] [--json]
heypi eval check [--evals ./evals] [--tag smoke] [--json]
heypi eval run <name> [--evals ./evals] [--agent ./agent] [--model openai/gpt-5.4-mini] [--runtime-root ./workspace] [--db ./state/heypi.db] [--agent-id default] [--json]
heypi eval run <name> [--evals ./evals] [--agent ./agent] (--result result.json | --text <text>) [--tools a,b] [--approvals id] [--db ./state/heypi.db] [--agent-id default] [--json]
```

Loads `defineEval(...)` definitions recursively from root `evals/` by default. `run` has two modes: with `--result` or `--text`, it evaluates assertions against supplied output; without supplied output, it runs the eval prompt through a local Pi-backed heypi handler using `--model` or `HEYPI_MODEL`. Agent-backed runs use isolated temporary state and workspace by default. When `--db` is supplied, `run` appends an `eval.completed` or `eval.failed` trace event; agent-backed runs also copy their temporary trace events into the persisted eval trace without temp thread, turn, or call ids.

| Subcommand | Description |
| --- | --- |
| `list` | Lists discovered eval definitions. |
| `show <name>` | Shows one eval definition. |
| `check` | Validates eval definition shape and assertions. |
| `run <name>` | Runs assertions against supplied output or a local agent-backed eval run. |

| Option | Description |
| --- | --- |
| `--evals <path>` | Eval folder. Defaults to `./evals`. |
| `--agent <path>` | Agent folder for agent-backed `run`. Defaults to `./agent`. |
| `--tag <tag>` | Filters `list` and `check` to evals with a tag. |
| `--result <path>` | JSON result file with `text`, `tools`, and `approvals` for `run`. |
| `--text <text>` | Inline assistant text for `run`. |
| `--tools <names>` | Comma-separated tool names for `run`. |
| `--approvals <ids>` | Comma-separated approval ids for `run`. |
| `--model <provider/name>` | Model for agent-backed `run`. Defaults to `HEYPI_MODEL`. |
| `--runtime-root <path>` | Workspace root for agent-backed `run`. Defaults to a temporary directory. |
| `--db <path>` | Persists an eval trace event for `run` in a migrated SQLite database. |
| `--agent-id <id>` | Agent id for persisted eval trace events. Defaults to `default`. |
| `--json` | Prints machine-readable output. |

Run migrations during deploy before starting the app:

```bash
heypi db migrate --db ./state/heypi.db
```

## heypi slack

```bash
heypi slack check [--env .env] [--mode socket|http] [--bot-token <token>] [--app-token <token>] [--signing-secret <secret>]
heypi slack manifest --mode socket
heypi slack manifest --mode http --url https://host/slack/slack/events
heypi slack channels [query] [--env .env] [--bot-token <token>] [--private] [--query <text>]
heypi slack users [query] [--env .env] [--bot-token <token>] [--bots] [--query <text>]
heypi slack env
```

| Subcommand | Description |
| --- | --- |
| `check` | Verifies Slack bot auth and reports Socket Mode or HTTP secret presence. |
| `manifest` | Prints a starter Slack app manifest for Socket Mode or HTTP mode. |
| `channels` | Lists visible Slack channel IDs. |
| `users` | Lists visible Slack user IDs. |
| `env` | Prints expected Slack environment variables. |

| Option | Applies to | Description |
| --- | --- | --- |
| `--env <path>` | `check`, `channels`, `users` | Load env file. Relative paths resolve from the original command directory. |
| `--bot-token <token>` | `check`, `channels`, `users` | Use instead of `SLACK_BOT_TOKEN`. |
| `--app-token <token>` | `check` | Use instead of `SLACK_APP_TOKEN`. Needed only for Socket Mode. |
| `--signing-secret <secret>` | `check` | Use instead of `SLACK_SIGNING_SECRET`. Needed only for HTTP mode. |
| `--mode socket\|http` | `check`, `manifest` | Select Slack transport mode. Required for `manifest`; optional for `check`. |
| `--url <url>` | `manifest` | Event and interactivity request URL for HTTP mode. |
| `--private` | `channels` | Include private channels visible to the bot. |
| `--bots` | `users` | Include Slack bot users. |
| `[query]` | `channels`, `users` | Positional filter for visible rows by name or ID. User lookup also checks real names. |
| `--query <text>` | `channels`, `users` | Explicit filter alternative to positional `[query]`. |

Examples:

```bash
heypi slack manifest --mode socket
heypi slack manifest --mode http --url https://agent.example.com/slack/slack/events
heypi slack channels devops --env .env
heypi slack channels ops --env .env --private
heypi slack users ronan --env .env
```

## heypi telegram

```bash
heypi telegram check [--env .env] [--token <token>]
heypi telegram observe [--env .env] [--token <token>] [--timeout 60]
heypi telegram set-webhook [--env .env] [--token <token>] --url <url> --secret-token <token>
heypi telegram delete-webhook [--env .env] [--token <token>]
```

| Subcommand | Description |
| --- | --- |
| `check` | Verifies Telegram bot credentials with `getMe`. |
| `observe` | Waits for a delivered message and prints Telegram chat IDs. |
| `set-webhook` | Registers Telegram webhook delivery for `message` and `callback_query` updates, then registers heypi bot commands. |
| `delete-webhook` | Removes Telegram webhook delivery so polling can be used again. |

| Option | Description |
| --- | --- |
| `--env <path>` | Load env file. |
| `--token <token>` | Use instead of `TELEGRAM_BOT_TOKEN`. |
| `--timeout <seconds>` | Wait time for `observe`. Defaults to `60`. |
| `--url <url>` | Public HTTPS Telegram webhook URL for `set-webhook`. |
| `--secret-token <token>` | Required for `set-webhook`. Secret token passed to Telegram and checked by webhook mode. |

Telegram cannot enumerate chats. Send `/start` to the bot, or post in the target group, supergroup, or forum topic, then run:

```bash
heypi telegram observe --env .env
```

`observe` deletes any active webhook for the token before polling. Do not run it next to another long-polling process for the same bot.

Webhook mode uses the adapter path `/telegram/<adapter-name>/webhook`; the default adapter URL path is `/telegram/telegram/webhook`.

## heypi discord

```bash
heypi discord check [--env .env] [--token <token>]
heypi discord observe [--env .env] [--token <token>] [--timeout 60]
heypi discord channels [query] [--env .env] [--token <token>] [--query <text>]
heypi discord invite [--client-id <application-id>]
heypi discord env
```

| Subcommand | Description |
| --- | --- |
| `check` | Verifies Discord bot credentials and prints an invite URL. |
| `observe` | Waits for a delivered message and prints guild, channel, and user IDs. |
| `channels` | Lists Discord text channels visible to the bot. |
| `invite` | Prints a Discord install URL. Uses `DISCORD_CLIENT_ID` when `--client-id` is omitted. |
| `env` | Prints expected Discord environment variables. |

| Option | Applies to | Description |
| --- | --- | --- |
| `--env <path>` | `check`, `observe`, `channels` | Load env file. |
| `--token <token>` | `check`, `observe`, `channels` | Use instead of `DISCORD_BOT_TOKEN`. |
| `--client-id <id>` | `invite` | Use instead of `DISCORD_CLIENT_ID`. |
| `--timeout <seconds>` | `observe` | Wait time. Defaults to `60`. |
| `[query]` | `channels` | Positional filter for visible rows by guild name, channel name, or ID. |
| `--query <text>` | `channels` | Explicit filter alternative to positional `[query]`. |

Discord IDs are snowflakes. Keep them as strings; do not coerce them through JavaScript numbers.

Examples:

```bash
heypi discord invite --client-id <application-id>
heypi discord channels engineering --env .env
heypi discord observe --env .env
```

## heypi admin

```bash
heypi admin link [--env .env] [--state ./state] [--url http://127.0.0.1:4321] [--pid <pid>] [--json]
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
heypi admin link --state ./state --url https://agent.example.com
```

## heypi approvals

```bash
heypi approvals list --db ./state/heypi.db [--agent <id>] [--limit 25] [--json]
heypi approvals show <id> --db ./state/heypi.db [--agent <id>] [--json]
heypi approvals bypasses --db ./state/heypi.db [--agent <id>] [--limit 25] [--json]
```

Approval commands are read-only. Approve or reject from the original chat provider so the audit trail records the provider actor.

| Subcommand | Description |
| --- | --- |
| `list` | Lists pending approvals. |
| `show <id>` | Shows one approval. |
| `bypasses` | Lists active temporary approval bypasses. |

| Option | Applies to | Description |
| --- | --- | --- |
| `--db <path>` | All | Required SQLite database path. |
| `--agent <id>` | All | Filter rows for one agent. |
| `--limit <count>` | `list`, `bypasses` | Maximum rows. Defaults to `25`. |
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
| `run <id>` | Queues one immediate run for each current job target. |
| `pause <id>` | Sets a job state to `paused`. |
| `resume <id>` | Sets a job state to `active`. |

| Option | Applies to | Description |
| --- | --- | --- |
| `--db <path>` | All | Required SQLite database path. |
| `--agent <id>` | All | Filter or mutate jobs for one agent. |
| `--limit <count>` | `list` | Maximum rows. Defaults to `100`. |
| `--json` | `list`, `show` | Print raw JSON. |

`jobs run` does not execute the job inside the CLI process. It inserts queued `job_run` rows for the job's current targets; a running heypi app claims and executes them without changing the job's normal schedule.

Example:

```bash
heypi jobs run daily-report --db ./state/heypi.db --agent ops
```

## Help and version

```bash
heypi help
heypi version
```

`help` prints CLI usage. `version` prints the installed `@hunvreus/heypi` package version.

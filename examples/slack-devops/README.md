# Slack DevOps

Slack DevOps assistant for configured Linux/VPS hosts. It demonstrates scoped Slack behavior, runbook search, local runtime tools, approval-gated remote host tools, SSH public-key onboarding, and file-backed host inventory.

This example uses Slack Socket Mode so it can run locally without a public HTTPS URL.

## How It Works

The agent loads:

- `SOUL.md` and `AGENTS.md` for role, style, scope, and operating constraints. `SYSTEM.md` is only for advanced runtime-prompt overrides.
- `skills/incident-triage/SKILL.md` for the incident workflow.
- Markdown runbooks from `runbooks/`, searched through the `runbook_search` custom tool.
- Dynamic host context from `state/hosts.json`, appended to the prompt each turn so the agent can recognize host ids, tags, and aliases before choosing tools.
- Custom host tools from `tools/host.ts` for SSH key onboarding, host inventory, cached host facts, and remote SSH execution.
- Core runtime tools through `coreTools({ bash: true })`. Local bash is enabled without command confirmation in this example; remote SSH commands run through `host_exec` with command policy, approval checks, and audit rows.

Runbooks are plain Markdown files under `agent/runbooks/`, exposed through `tools/runbook.ts`. The skill tells the agent when to use `runbook_search` and how to apply the results.

## Run

```bash
cp examples/slack-devops/.env.example examples/slack-devops/.env
pnpm run dev:slack
```

The repo script runs `index.ts` with `examples/slack-devops` as the working directory.

This example enables the local admin panel by default:

```text
http://127.0.0.1:3000/admin
```

Admin auth is disabled in this local loopback example, so no login link is required. Do not expose this example admin server on a public interface with auth disabled.

When `HEYPI_SLACK_JOB_CHANNEL` is set, the example configures two jobs so the admin Jobs tab has real app-level state:

- `daily-health-check`: active cron job, scheduled for 09:00 UTC and delivered to `HEYPI_SLACK_JOB_CHANNEL`.
- `idle-incident-follow-up`: paused heartbeat job for quiet incident threads in `HEYPI_SLACK_JOB_CHANNEL`.

If `HEYPI_SLACK_JOB_CHANNEL` is unset, the example logs a warning, starts normally, and skips those jobs. Jobs run inside the heypi Node process; no external cron service is required.

Required env vars:

```bash
SLACK_BOT_TOKEN=...
SLACK_APP_TOKEN=...
OPENAI_API_KEY=...
```

Optional env vars:

```bash
HEYPI_APPROVERS=U123456,U234567
HEYPI_SLACK_TEAMS=
HEYPI_SLACK_CHANNELS=
HEYPI_SLACK_USERS=
HEYPI_SLACK_JOB_CHANNEL=C1234567890
```

Leave the `HEYPI_SLACK_*` allowlists empty to accept every event Slack delivers. Set comma-separated IDs to restrict which teams, channels, or users may trigger the agent.

`SLACK_SIGNING_SECRET` is only required for HTTP mode. Socket Mode uses `SLACK_APP_TOKEN`.

This example enables `streaming: true`. See [`../../packages/heypi/docs/CHAT.md`](../../packages/heypi/docs/CHAT.md) for shared chat defaults, streaming, approvals, cancel, and busy-thread behavior.

Check setup:

```bash
pnpm heypi slack check --env examples/slack-devops/.env
pnpm heypi slack channels --env examples/slack-devops/.env
pnpm heypi slack manifest --url https://<host>/slack/slack/events
```

Use `slack channels` to find the channel ID for `HEYPI_SLACK_JOB_CHANNEL`. If you keep the env file at `./.env`, the CLI loads it automatically and `--env` is optional.

Invite the Slack app to any channel where it should answer. heypi's allowlists filter events after Slack delivers them; they do not make Slack send events for channels the bot has not joined.

Smoke test from the repo root:

1. Fill `examples/slack-devops/.env` with `SLACK_BOT_TOKEN`, `SLACK_APP_TOKEN`, and `OPENAI_API_KEY`.
2. Run `pnpm heypi slack check --env examples/slack-devops/.env`.
3. Run `pnpm heypi slack channels --env examples/slack-devops/.env`, then set `HEYPI_SLACK_CHANNELS` to the channel you want to test.
4. Invite the Slack app to that channel.
5. Run `pnpm run dev:slack`.
6. Mention the app in Slack, for example: `@heypi help`.

Try:

```text
help
Search runbooks for host onboarding
Show configured hosts
Generate the public SSH key for default
Add web-1 at 203.0.113.10 as deploy and tag it web,prod
Run uptime on web-1
Search runbooks for disk space
Check Linux health on prod hosts
bash find . -maxdepth 3 -type f
```

Live host inventory and generated SSH keys are stored under the explicit `state.root` (`./state`), which is gitignored.
Because the example omits `store`, heypi uses SQLite at `state/heypi.db`.
The first host uses the `default` key unless you provide another key name. Keys are generated once and reused; `hosts.json` stores the key name and public key, not private key material.

First host setup:

1. Ask the bot to add the host, for example: `Add web-1 at 203.0.113.10 as deploy and tag it web,prod`.
2. Approve the `hosts_upsert` request if approvals are enabled.
3. Copy the public key returned by Slack into `~/.ssh/authorized_keys` for that SSH user on the VPS.
4. Tell the bot the key is installed. It can then test the connection and refresh cached facts with safe probes.

If `HEYPI_APPROVERS` is empty, any Slack user who can interact with the bot can approve pending actions. Set `HEYPI_APPROVERS` for a real workspace.

Host tools:

- `host_key_ensure`: creates a named SSH keypair if missing and returns only the public key.
- `host_key_public`: shows the public key to add to `~/.ssh/authorized_keys` on a VPS.
- `hosts_list` / `hosts_lookup`: inspect file-backed host inventory.
- `hosts_upsert` / `hosts_remove`: add, update, or remove hosts. These require approval. `hosts_upsert` also ensures the named key exists and returns the public key to install.
- `host_facts_refresh`: probes and persists hostname, OS, architecture, kernel, distro, package manager, service manager, container runtime/version, root disk, memory, ports 80/443, git user, and passwordless sudo availability.
- `host_exec`: runs commands over SSH from the heypi Node process. Each call includes a human purpose. Risky commands require approval through `commandConfirm()` and show target/command approval details; blocked commands do not run.

`just-bash` remains the local workspace runtime. Remote SSH commands do not run inside `just-bash`; they run through `host_exec`.

The example enables `just-bash` network access so local bash can use `curl` for public documentation lookup. Keep this disabled or use a stricter `network.allowedUrlPrefixes` config if the agent should not reach arbitrary public URLs.

This example is intentionally more involved than the Telegram example: it shows custom tools, tool confirmation, file-backed state, SSH key generation, and a separate remote execution surface next to the local `just-bash` runtime.

## Slack HTTP Mode

For production-style Slack HTTP mode, use the commented block in `index.ts`:

```ts
slack({
	botToken: required("SLACK_BOT_TOKEN"),
	signingSecret: required("SLACK_SIGNING_SECRET"),
	mode: "http",
	allow: {
		teams: list("HEYPI_SLACK_TEAMS"),
		channels: list("HEYPI_SLACK_CHANNELS"),
		users: list("HEYPI_SLACK_USERS"),
	},
	trigger: "mention",
	reply: "thread",
	streaming: true,
});
```

With these defaults, top-level channel messages require a mention and thread replies do not.

In Slack app settings, set Event Subscriptions and Interactivity URLs to `https://<host>/slack/slack/events`. If you set a custom adapter `name`, use `/slack/<name>/events`. Configure non-default host/port with top-level `http`.

The admin panel uses the same HTTP listener as Slack HTTP mode and remains available at `/admin` when enabled.

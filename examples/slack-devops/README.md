# Slack DevOps

Slack DevOps assistant for configured Linux/VPS hosts. It demonstrates scoped Slack behavior, runbook search, governed local bash, approval-gated remote host tools, SSH public-key onboarding, and file-backed host inventory.

This example uses Slack Socket Mode so it can run locally without a public HTTPS URL.

## How It Works

The agent loads:

- `SYSTEM.md` and `AGENTS.md` for role, scope, and safety constraints.
- `skills/incident-triage/SKILL.md` for the incident workflow.
- Markdown runbooks from `runbooks/`, searched through the `runbook_search` Pi extension.
- Custom host tools from `host-tools.ts` for SSH key onboarding, host inventory, and remote SSH execution.

Runbooks are still supported. In this example they are plain Markdown files under `agent/runbooks/`, exposed to the agent through `agent/extensions/runbook-tools.ts`. The skill tells the agent when to use `runbook_search` and how to apply the results.

## Run

```bash
cp examples/slack-devops/.env.example examples/slack-devops/.env
pnpm run dev:slack
```

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
```

Leave the `HEYPI_SLACK_*` allowlists empty to accept every event Slack delivers. Set comma-separated IDs to restrict which teams, channels, or users may trigger the agent.

`SLACK_SIGNING_SECRET` is only required for HTTP mode. Socket Mode uses `SLACK_APP_TOKEN`.

This example enables `streaming: true`, so Slack replies are posted as draft messages and edited while Pi emits text. Delivery pacing and rate-limit retries use heypi's defaults.

Check setup:

```bash
pnpm heypi slack check --env examples/slack-devops/.env
pnpm heypi slack manifest --url https://<host>/slack/events
```

Invite the Slack app to any channel where it should answer. heypi's allowlists filter events after Slack delivers them; they do not make Slack send events for channels the bot has not joined.

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

Live host inventory and generated SSH keys are stored under `examples/slack-devops/state/`, which is gitignored.
The first host uses the `default` key unless you provide another key name. Keys are generated once and reused; `hosts.json` stores the key name and public key, not private key material.

First host setup:

1. Ask the bot to add the host, for example: `Add web-1 at 203.0.113.10 as deploy and tag it web,prod`.
2. Approve the `hosts_upsert` request if approvals are enabled.
3. Copy the public key returned by Slack into `~/.ssh/authorized_keys` for that SSH user on the VPS.
4. Tell the bot the key is installed. It can then test the connection with a safe command.

Host tools:

- `host_key_ensure`: creates a named SSH keypair if missing and returns only the public key.
- `host_key_public`: shows the public key to add to `~/.ssh/authorized_keys` on a VPS.
- `hosts_list` / `hosts_lookup`: inspect file-backed host inventory.
- `hosts_upsert` / `hosts_remove`: add, update, or remove hosts. These require approval. `hosts_upsert` also ensures the named key exists and returns the public key to install.
- `host_exec`: runs commands over SSH from the heypi Node process. Risky commands require approval; blocked commands do not run.

`just-bash` remains the local workspace runtime. Remote SSH commands do not run inside `just-bash`; they run through `host_exec`.

This example is intentionally more involved than the Telegram example: it shows custom tools, tool confirmation, file-backed state, SSH key generation, and a separate remote execution surface next to the local `just-bash` runtime.

## Slack HTTP Mode

For production-style Slack HTTP mode, use the commented block in `index.ts`:

```ts
slack({
	botToken: required("SLACK_BOT_TOKEN"),
	signingSecret: required("SLACK_SIGNING_SECRET"),
	mode: "http",
	port: Number(process.env.PORT ?? 3000),
	path: "/slack/events",
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

In Slack app settings, set Event Subscriptions and Interactivity URLs to `https://<host>/slack/events`, or to the custom `path` you configured.

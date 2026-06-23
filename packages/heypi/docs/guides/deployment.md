# Deployment

Deploy heypi as one long-running Node.js service with persistent storage. Use a VPS, VM, container host, or single-instance app platform where the process can keep adapters, schedulers, runtime providers, and delivery queues alive.

This guide assumes you already have a heypi app entrypoint, agent instructions, and package scripts. For app creation, start with the [Quickstart](../quickstart/index.md).

## Deployment model

Run one heypi process per app/agent store. The process owns:

- chat adapters such as Slack Socket Mode, Discord gateway, Telegram polling, or HTTP webhooks,
- scheduled jobs and heartbeat checks,
- the app lock and thread locks,
- runtime workspaces and managed runtime providers,
- local delivery queues and provider rate-limit retries.

Use the app lock as a guardrail, not as a scaling mechanism. Multi-process deployments need a custom shared store, distributed delivery limiting, and operational review before they are safe.

## Restart and durability

Persistent SQLite state, admin metadata, memory, skills, runtime workspace files, generated attachments, and stored secrets survive process restarts when `state` and `workspace` are on durable storage.

Startup recovery cleans up known interrupted work:

- turns and tool calls left running are marked failed and get recovery events in the trace timeline,
- scheduled job runs left running are returned to the queued state,
- database locks expire so future turns can continue.

Process-local coordination does not survive an exact restart:

- pending secret request prompts,
- active steer and follow-up queues,
- local delivery queues and provider retry timers,
- async webhook turns that were accepted and still running when the process stopped.

This is inspection and cleanup, not workflow replay. Use a supervisor to restart the service quickly, avoid multi-instance deployments unless you provide the required shared coordination, and design external webhook callers to retry when they need completion guarantees.

## Requirements

- Node.js 22 or newer.
- Persistent `state` directory.
- Persistent `workspace` directory.
- Environment variables for the model provider and adapters.
- Optional: Docker if the app uses `@hunvreus/heypi-runtime-docker`.
- Optional: Node.js 23.6 or newer plus QEMU if the app uses `@hunvreus/heypi-runtime-gondolin`.

Keep `state` and `workspace` outside release directories so upgrades do not delete durable data. `state` contains the SQLite database and admin state. `workspace` contains Pi session files, scoped runtime files, generated attachments, memory, skills, and runtime-scoped secrets.

## Prepare the server

Copy or deploy your app to a stable directory, for example `/opt/heypi`.

The server should contain:

- `package.json` and lockfile,
- app entrypoint such as `index.ts` or built `dist/index.js`,
- agent folder,
- `.env`,
- persistent `state/`,
- persistent `workspace/`.

Install dependencies with the package manager your app already uses:

```bash
npm ci
```

If you deploy TypeScript directly, include a runner such as `tsx` in your app dependencies. If you compile first, run the compiled JavaScript in production.

Create durable directories before first start:

```bash
mkdir -p state workspace
```

## Configure environment

Create `.env` on the server and keep it out of git:

```bash
OPENAI_API_KEY=...
HEYPI_MODEL=openai/gpt-5.4-mini
SLACK_BOT_TOKEN=xoxb-...
SLACK_APP_TOKEN=xapp-...
HEYPI_ADMIN_SECRET=replace-with-a-long-random-secret
```

Use the env var for your selected model provider. For example, Anthropic uses `ANTHROPIC_API_KEY`, Google Gemini uses `GEMINI_API_KEY`, and xAI uses `XAI_API_KEY`.

Use the adapter docs for provider-specific variables:

- [Slack](../adapters/slack.md)
- [Discord](../adapters/discord.md)
- [Telegram](../adapters/telegram.md)
- [Webhook](../adapters/webhook.md)

Run diagnostics before starting the service:

```bash
npm exec heypi -- doctor --boot --env .env --db ./state/heypi.db --runtime-root ./workspace
```

## Run with systemd

Create `/etc/systemd/system/heypi.service`:

```ini
[Unit]
Description=heypi
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=/opt/heypi
EnvironmentFile=/opt/heypi/.env
ExecStart=/usr/bin/npm run start
Restart=always
RestartSec=5
User=heypi
Group=heypi

[Install]
WantedBy=multi-user.target
```

Create the service user and start heypi:

```bash
sudo useradd --system --create-home --home-dir /opt/heypi heypi
sudo chown -R heypi:heypi /opt/heypi
sudo systemctl daemon-reload
sudo systemctl enable --now heypi
sudo journalctl -u heypi -f
```

If Node is installed through a version manager, replace `/usr/bin/npm` with the absolute path available to the `heypi` user.

Use `Restart=always` or equivalent supervision. The app records interrupted turns during startup recovery, but a supervisor is still responsible for bringing the process back.

## Run with Docker

Use Docker when you want a repeatable process environment. Mount state and workspace directories as volumes.

```dockerfile
FROM node:22-bookworm
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
CMD ["npm", "run", "start"]
```

Example run command:

```bash
docker build -t heypi-app .
docker run -d \
  --name heypi \
  --restart unless-stopped \
  --env-file .env \
  -v "$PWD/state:/app/state" \
  -v "$PWD/workspace:/app/workspace" \
  heypi-app
```

If the app itself uses the Docker runtime provider, mount the Docker socket or use a remote Docker daemon intentionally. That gives the heypi process control over containers.

## Runtime providers

Choose the runtime provider based on what the agent is allowed to touch:

- `just-bash`: default production runtime for scoped command/file tools.
- Docker runtime provider: use when command execution should run in containers.
- Gondolin runtime provider: use when command execution should run in managed microVMs.
- `host-bash` or `guarded-bash`: use only for trusted development or administrative agents.

Managed runtime providers keep scoped runtimes warm until idle timeout or shutdown. Plan CPU, memory, disk, and cleanup around the number of active scopes.

Keep state and runtime workspace directories private to the heypi OS user on shared hosts. State contains transcripts, calls, approvals, jobs, and admin metadata. Runtime workspaces can contain generated files, attachments, and runtime-scoped secrets. A typical service setup should create these directories with `0700` permissions before starting heypi.

## Expose HTTP routes

If you use Slack HTTP mode, webhooks, or self-hosted secrets, configure the public heypi HTTP listener and put it behind HTTPS. Admin uses its own listener through `admin.http`.

Common production shape:

- public webhooks listen on localhost, a private container port, or an explicitly exposed `0.0.0.0` port.
- admin listens on `127.0.0.1:4321` or another private `admin.http` address.
- Caddy, nginx, a load balancer, or the platform proxy terminates HTTPS.
- Only provider webhook routes are public.
- Admin is protected by heypi auth and additional network controls.

Generate an admin login link from the server:

```bash
npm exec heypi -- admin link --state ./state --url http://127.0.0.1:4321
```

For remote access, prefer an SSH tunnel, private networking, VPN, IP allowlist, or authenticated reverse proxy in addition to heypi admin auth.

## Process ownership

By default, heypi takes an app lock in the configured store before starting adapters and schedulers. This prevents two Node processes with the same agent id from consuming the same chat events, scheduler jobs, SQLite state, and runtime workspace at the same time.

```ts
createHeypi({
  appLock: {
    ttlMs: 60_000,
    drainMs: 30_000,
  },
  // ...state, adapters, agent, runtime
});
```

| Option | Default | Description |
| --- | --- | --- |
| `appLock.ttlMs` | `60_000` | Lock lease duration. heypi refreshes it while running. |
| `appLock.drainMs` | `30_000` | Time allowed for active runs to drain during shutdown. |

Set `appLock: false` only when an external supervisor guarantees single ownership. Custom stores used with app locking must implement `locks`.

## Backups

Back up `state/` before upgrades and on a regular schedule. Back up `workspace/` if you need to preserve Pi sessions, memory, skills, generated files, attachments, or runtime-scoped secrets.

For SQLite, stop the service or use a SQLite-safe backup method before copying `state/heypi.db`.

## Logging

heypi logs structured events through `logger`. The default is pretty console output at `info` level. Use JSON in production when logs are collected by journald, Docker, or a log pipeline:

```ts
import { consoleLogger } from "@hunvreus/heypi";

createHeypi({
  logger: consoleLogger({ level: "info", format: "json" }),
  // ...state, adapters, agent, runtime
});
```

Custom loggers implement `debug`, `info`, `warn`, and `error`. heypi redacts common provider tokens and credentials before writing through the built-in console logger.

Monitor for:

- `app.locked`, `app.lock_refresh_lost`, and startup recovery warnings,
- adapter delivery failures and provider rate-limit retries,
- failed turns, failed tool calls, and pending approvals,
- runtime provider capacity, idle cleanup, and disk usage.

## Upgrade

For `0.2.0-beta.0` breaking changes, read the [Migration guide](migration.md) before updating production bots.

Stop the service, update packages, run diagnostics, then restart:

```bash
sudo systemctl stop heypi
npm install
npm exec heypi -- doctor --boot --env .env --db ./state/heypi.db --runtime-root ./workspace
sudo systemctl start heypi
```

Keep `state/` and `workspace/` mounted across releases. If a migration fails, restore the backup, fix the deployment, and rerun `heypi doctor --boot` before starting the service.

## Shutdown

`runHeypi(app)` handles process signals and stops adapters, schedulers, stores, and runtime providers cleanly.

For manual lifecycle control, call `await app.stop()` before the Node process exits.

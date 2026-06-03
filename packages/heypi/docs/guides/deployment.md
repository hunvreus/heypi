# Deployment

Deploy heypi as one long-running Node.js service. Use a VPS, VM, container, or single-instance app host with persistent storage.

This guide assumes you already have a heypi app entrypoint, prompt files, and package scripts. For app creation, start with the [Quickstart](../quickstart/index.md).

## Requirements

- Node.js 22 or newer.
- Persistent `state` directory.
- Persistent `workspace` directory.
- Environment variables for the model provider and adapters.
- Optional: Docker if the app uses `@hunvreus/heypi-runtime-docker`.
- Optional: Node.js 23.6 or newer plus QEMU if the app uses `@hunvreus/heypi-runtime-gondolin`.

Keep `state` and `workspace` outside ephemeral deploy directories. `state` contains durable app state; `workspace` contains scoped runtime files, generated attachments, and runtime-scoped secrets.

## Prepare the server

Copy or deploy your app to a stable directory, for example `/opt/heypi`.

The server should contain:

- `package.json` and lockfile,
- app entrypoint such as `index.ts` or built `dist/index.js`,
- agent prompt folder,
- `.env`,
- persistent `state/`,
- persistent `workspace/`.

Install dependencies with the package manager your app already uses:

```bash
npm ci
```

If you deploy TypeScript directly, include a runner such as `tsx` in your app dependencies. If you compile first, run the compiled JavaScript in production.

## Configure environment

Create `.env` on the server and keep it out of git:

```bash
OPENAI_API_KEY=...
HEYPI_MODEL=openai/gpt-5-mini
SLACK_BOT_TOKEN=xoxb-...
SLACK_APP_TOKEN=xapp-...
HEYPI_ADMIN_SECRET=replace-with-a-long-random-secret
```

Use the adapter docs for provider-specific variables:

- [Slack](../adapters/slack.md)
- [Discord](../adapters/discord.md)
- [Telegram](../adapters/telegram.md)
- [Webhook](../adapters/webhook.md)

Run a setup check before starting the service:

```bash
npm exec heypi -- check --env .env --db ./state/heypi.db --runtime-root ./workspace
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

## Expose HTTP routes

If you use Slack HTTP mode, webhooks, secrets, or the admin UI, configure the heypi HTTP listener and put it behind HTTPS.

Common production shape:

- heypi listens on localhost or a private container port.
- Caddy, nginx, a load balancer, or the platform proxy terminates HTTPS.
- Only provider webhook routes are public.
- Admin is protected by heypi auth and additional network controls when possible.

Generate an admin login link from the server:

```bash
npm exec heypi -- admin link --state ./state --url https://agent.example.com
```

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

## Upgrade

Stop the service, update packages, run the check, then restart:

```bash
sudo systemctl stop heypi
npm install
npm exec heypi -- check --env .env --db ./state/heypi.db --runtime-root ./workspace
sudo systemctl start heypi
```

Back up the `state` directory before upgrades. Keep the `workspace` directory if you want scoped runtime files to survive deploys.

## Shutdown

`runHeypi(app)` handles process signals and stops adapters, schedulers, stores, and runtime providers cleanly.

For manual lifecycle control, call `await app.stop()` before the Node process exits.

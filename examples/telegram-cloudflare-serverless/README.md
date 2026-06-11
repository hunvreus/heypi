# Telegram on Cloudflare (serverless)

A heypi agent on Telegram with **no always-on bridge**. Telegram delivers updates over an HTTP
webhook straight to a Cloudflare Worker; the Worker routes each chat to a Durable Object (per-chat
lock + DO-SQLite transcript) and delegates the agent turn to a small **Pi runner service**.

```
Telegram  ──webhook(HTTPS)──▶  Worker /telegram        (Cloudflare, stateless)
                                  │  idFromName(chat)
                                  ▼
                               ThreadAgent Durable Object   (per-chat lock + DO-SQLite transcript)
                                  │  ContainerRunner (HTTP)
                                  ▼
                               Pi runner service  ──▶  PiAgent ──▶ LLM
                                  │
                               reply ──▶ Worker ──▶ Telegram sendMessage
```

Only the **runner** is a long-running process (in production a Cloudflare Container; locally a Node
process). The ingress is pure serverless — unlike Discord, Telegram needs no gateway connection.

## Why two processes?

The Worker/DO bundle is intentionally **Pi-free** — Pi imports Node builtins that don't load in the
Workers isolate. So the DO keeps session state and calls the runner, which runs the real agent in
Node. The Worker's `main` points directly at the reusable host in `packages/heypi-cloudflare`.

## Prerequisites

- A Telegram bot: message [@BotFather](https://t.me/BotFather) → `/newbot` → copy the token.
- An LLM key (Anthropic or OpenAI).
- A way to expose the local Worker publicly so Telegram can reach it — e.g.
  [`cloudflared`](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/)
  (`brew install cloudflared`) or `ngrok`.

## Setup

```bash
cp .dev.vars.example .dev.vars
# edit .dev.vars: TELEGRAM_BOT_TOKEN, ANTHROPIC_API_KEY (or OPENAI_API_KEY), HEYPI_MODEL,
# RUNNER_URL=http://127.0.0.1:8788, and optionally TELEGRAM_WEBHOOK_SECRET
```

## Run (4 terminals)

```bash
# 1) Pi runner service (the agent; reads .dev.vars for the model + key)
RUNNER_ENV="$PWD/.dev.vars" AGENT_DIR="$PWD/agent" RUNNER_STATE="$PWD/.runner-state" \
  node --import tsx --conditions development ../../packages/heypi-cloudflare/src/container/runner-server.ts

# 2) The Worker + Durable Object (auto-loads .dev.vars)
pnpm exec wrangler dev --port 8799

# 3) A public tunnel to the Worker
cloudflared tunnel --url http://localhost:8799      # prints https://<random>.trycloudflare.com

# 4) Point Telegram at the tunnel
TELEGRAM_BOT_TOKEN=... TUNNEL_URL=https://<random>.trycloudflare.com ./set-webhook.sh
```

Now DM your bot on Telegram. Each chat is its own Durable Object, so conversation memory persists
per chat in DO-SQLite.

Check delivery anytime with `TELEGRAM_BOT_TOKEN=... ./set-webhook.sh` (prints `getWebhookInfo`).

## Deploying for real

- `wrangler deploy` the Worker (gives a public `*.workers.dev` URL — no tunnel needed).
- Run the runner as a Cloudflare Container (or any Node host) and set `RUNNER_URL` to it.
- Set `TELEGRAM_BOT_TOKEN` / `TELEGRAM_WEBHOOK_SECRET` with `wrangler secret put`.
- Point the webhook at the deployed URL with `set-webhook.sh`.

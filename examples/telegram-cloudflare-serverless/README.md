# Telegram on Cloudflare (serverless)

A heypi agent on Telegram with **no always-on bridge**. Telegram delivers updates over an HTTP
webhook straight to a Cloudflare Worker; the Worker routes each chat to a Durable Object (per-chat
lock + DO-SQLite transcript) and delegates the agent turn to the Pi agent running in a **Cloudflare
Container**. The whole stack runs on Cloudflare.

```
Telegram ──webhook(HTTPS)──▶ Worker /telegram        (Cloudflare, stateless)
                               │  getByName(chat)
                               ▼
                            ThreadAgent Durable Object   (per-chat lock + DO-SQLite transcript)
                               │  PI_RUNNER binding
                               ▼
                            PiRunner Container  ──▶  PiAgent ──▶ LLM
                               │
                            reply ──▶ Worker ──▶ Telegram sendMessage
```

Unlike Discord, Telegram needs no gateway connection — the ingress is pure serverless. The agent
runs in a container because Pi imports Node builtins that don't load in the Workers isolate; the DO
keeps session state and calls the container with the transcript.

## Prerequisites

- **Docker** running locally (wrangler builds and runs the container image).
- A **Telegram bot**: message [@BotFather](https://t.me/BotFather) → `/newbot` → copy the token.
- An **LLM key** (Anthropic or OpenAI).
- A **Cloudflare account on the Workers Paid plan** (Durable Objects + Containers require it) for
  deploying; `wrangler login`.
- For local testing, a tunnel to expose the Worker — e.g. `cloudflared` (`brew install cloudflared`).

## Setup

```bash
cp .dev.vars.example .dev.vars
# edit .dev.vars: TELEGRAM_BOT_TOKEN, ANTHROPIC_API_KEY (or OPENAI_API_KEY), HEYPI_MODEL,
# and optionally TELEGRAM_WEBHOOK_SECRET
```

## Run locally (3 terminals)

```bash
# 1) Worker + Durable Object + Pi container (wrangler builds the image on first run)
pnpm dev                                  # http://127.0.0.1:8799

# 2) Public tunnel to the Worker
cloudflared tunnel --url http://localhost:8799      # prints https://<random>.trycloudflare.com

# 3) Point Telegram at the tunnel (token read from .dev.vars)
TUNNEL_URL=https://<random>.trycloudflare.com pnpm webhook
```

DM your bot. Each chat is its own Durable Object, so memory persists per chat in DO-SQLite. Check
delivery anytime with `pnpm webhook` (prints `getWebhookInfo`).

> First `pnpm dev` builds the container image (a few minutes). Subsequent runs are fast.

## Deploy

```bash
wrangler login
# secrets (not committed):
pnpm exec wrangler secret put TELEGRAM_BOT_TOKEN
pnpm exec wrangler secret put ANTHROPIC_API_KEY
pnpm exec wrangler secret put HEYPI_MODEL            # or set as a [vars] entry
# optional: pnpm exec wrangler secret put TELEGRAM_WEBHOOK_SECRET

pnpm deploy                                          # builds + pushes the image, deploys the Worker

# point Telegram at the deployed Worker (no tunnel needed):
TELEGRAM_BOT_TOKEN=... TUNNEL_URL=https://<your-worker>.workers.dev pnpm webhook
```

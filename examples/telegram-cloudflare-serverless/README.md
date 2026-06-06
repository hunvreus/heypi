# Telegram on Cloudflare (serverless)

A heypi agent on Telegram with **no always-on bridge**, runnable on free tiers. Telegram delivers
updates over an HTTP webhook straight to a Cloudflare Worker; the Worker routes each chat to a
Durable Object (per-chat lock + DO-SQLite transcript) and delegates the agent turn to the Pi runner
over HTTP. The runner runs on **Modal** (free credits, scales to zero); the Worker + Durable Object
run on **Cloudflare's free plan** (SQLite-backed DOs are free-tier).

```
Telegram ──webhook(HTTPS)──▶ Worker /telegram        (Cloudflare, free)
                               │  getByName(chat)
                               ▼
                            ThreadAgent Durable Object   (per-chat lock + DO-SQLite transcript)
                               │  RUNNER_URL (HTTPS)
                               ▼
                            Pi runner on Modal  ──▶  PiAgent ──▶ LLM
                               │
                            reply ──▶ Worker ──▶ Telegram sendMessage
```

Unlike Discord, Telegram needs no gateway connection — ingress is pure serverless. The agent runs
off-Worker because Pi imports Node builtins that don't load in the Workers isolate.

> Prefer to keep everything on Cloudflare? You can run the runner on **Cloudflare Containers**
> instead (add the `containers` + `PI_RUNNER` binding from `packages/heypi-cloudflare/wrangler.jsonc`).
> That requires the Workers Paid plan; the Modal path below is free.

## Prerequisites

- A **Telegram bot**: message [@BotFather](https://t.me/BotFather) → `/newbot` → copy the token.
- An **LLM key** (Anthropic or OpenAI).
- A **Modal account** (`pip install modal && modal token new`) for the runner.
- A **Cloudflare account** (`wrangler login`) — free plan is fine.

## Local dev (3 terminals)

```bash
cp .dev.vars.example .dev.vars      # set TELEGRAM_BOT_TOKEN, ANTHROPIC_API_KEY, HEYPI_MODEL, RUNNER_URL

pnpm runner                          # 1) Pi runner on http://127.0.0.1:8788
pnpm dev                             # 2) Worker + Durable Object on :8799 (RUNNER_URL -> the runner)
cloudflared tunnel --url http://localhost:8799   # 3) public tunnel; copy the https URL
TUNNEL_URL=https://<random>.trycloudflare.com pnpm webhook   # point Telegram at it
```

DM your bot. Each chat is its own Durable Object, so memory persists per chat in DO-SQLite.

## Deploy (free)

**1. Runner on Modal** (run from the repo root so the Dockerfile sees the monorepo):

```bash
modal secret create heypi ANTHROPIC_API_KEY=sk-... HEYPI_MODEL=anthropic/claude-sonnet-4-6
modal deploy examples/telegram-cloudflare-serverless/modal_runner.py
# -> note the URL, e.g. https://<you>--heypi-runner-runner.modal.run
```

**2. Worker on Cloudflare** (from this directory):

```bash
wrangler login
pnpm exec wrangler secret put TELEGRAM_BOT_TOKEN
pnpm exec wrangler secret put RUNNER_URL          # value = the Modal URL above
# optional: pnpm exec wrangler secret put TELEGRAM_WEBHOOK_SECRET
pnpm run deploy                                   # `pnpm deploy` is a reserved pnpm command — use `run`
                                                  # -> https://<your-worker>.workers.dev
```

**3. Point Telegram at the deployed Worker:**

```bash
TELEGRAM_BOT_TOKEN=... TUNNEL_URL=https://<your-worker>.workers.dev pnpm webhook
```

DM your bot — it now runs entirely on free tiers: Cloudflare Worker + Durable Object, with the agent
on Modal.

# create-heypi

Create a heypi app:

```bash
npm create heypi@latest
```

Use `--yes` to accept defaults and generate non-interactively.

The wizard asks for:

- project directory
- adapter: Slack, Discord, Telegram, or webhook
- runtime: `just-bash`, Docker, Gondolin, or guarded bash
- model: curated defaults plus a custom `provider/model` input
- admin UI, sample skill/tool files, and dependency install

Generated apps include `agent/AGENTS.md`, `agent/SOUL.md`, `agent/skills/`, `tools/`, `.env.example`, and `.env`. Existing `.env` files are never overwritten.

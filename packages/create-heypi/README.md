# create-heypi

Create a heypi app:

```bash
npm create heypi@latest
```

Use `--yes` to accept defaults and generate non-interactively.

The wizard asks for:

- project directory
- adapter: Slack, Discord, Telegram, or webhook
- Slack transport: Socket Mode or HTTP webhook
- runtime: `just-bash`, Docker, Gondolin, or guarded bash
- model: curated defaults plus a custom `provider/model` input
- admin UI, sample skill/tool/eval files, and dependency install

Generated apps include `agent/AGENTS.md`, `agent/SOUL.md`, `agent/skills/`, `agent/tools/`, `agent/jobs/`, `agent/evals/`, `.env.example`, and `.env`. Existing `.env` files are never overwritten. Optional samples include a Zod-based `defineTool` module under `agent/tools/`.

Generated `npm run dev` uses `heypi dev`, which loads the exported app and enables the loopback-only `local()` adapter for `/dev/messages`. The local admin UI can inspect chats, approvals, jobs, memory, and eval definitions.

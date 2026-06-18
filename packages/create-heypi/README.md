# create-heypi

Create a heypi app:

```bash
npm create heypi@latest
```

Use `--yes` to accept defaults and generate non-interactively.

Useful flags:

- `--adapter slack|discord|telegram|webhook`
- `--runtime just-bash|guarded-bash|docker|gondolin`
- `--model provider/name`
- `--admin` or `--no-admin`
- `--samples` or `--no-samples`

The wizard asks for:

- project directory
- adapter: Slack, Discord, Telegram, or webhook
- Slack transport: Socket Mode or HTTP webhook
- runtime: `just-bash`, Docker, Gondolin, or guarded bash
- model: curated defaults plus a custom `provider/model` input
- admin UI, sample skill/tool/eval files, and dependency install

Generated apps include `agent/AGENTS.md`, `agent/SOUL.md`, `agent/skills/`, `agent/tools/`, `agent/jobs/`, `agent/evals/`, `.env.example`, and `.env`. Existing `.env` files are never overwritten. Optional samples include a Zod-based `defineTool` module under `agent/tools/`.

Generated `npm run dev` uses `heypi dev`, which loads the exported app with only the loopback-only `local()` adapter for `/dev/messages`. Production chat adapters are still wired in `index.ts`, but they are not started in dev mode. When admin is enabled, the local admin UI can inspect chats, approvals, jobs, memory, and eval definitions.

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

Generated apps include `agent/instructions.md`, `agent/skills/`, `agent/tools/`, `agent/jobs/`, root `evals/`, `.env.example`, and `.env`. Existing `.env` files are never overwritten. Optional samples include a Zod-based `defineTool` module under `agent/tools/`.

Generated `npm run dev` uses `heypi dev`, which starts the exported app, enables loopback-only `/dev/messages`, and turns on the local admin UI unless disabled. Production chat adapters remain wired in `index.ts` and also run in dev mode.

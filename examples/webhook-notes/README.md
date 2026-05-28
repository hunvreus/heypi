# Webhook Notes

Tiny webhook example that accepts JSON messages and stores short notes in local Markdown.

## Run

```bash
cp examples/webhook-notes/.env.example examples/webhook-notes/.env
pnpm run dev:webhook
```

The repo script runs `index.ts` with `examples/webhook-notes` as the working directory.

Required env vars:

```bash
OPENAI_API_KEY=...
HEYPI_WEBHOOK_SECRET=...
```

Send a message:

```bash
curl -X POST http://127.0.0.1:3000/webhook/notes/messages \
  -H "authorization: Bearer dev-secret-change-me" \
  -H "content-type: application/json" \
  -d '{"user":"demo","text":"Remember that the launch checklist needs a billing smoke test"}'
```

The response includes a `threadId` and `runId`. Check status:

```bash
curl http://127.0.0.1:3000/webhook/notes/threads/<threadId>/runs/<runId> \
  -H "authorization: Bearer dev-secret-change-me"
```

Notes and the default SQLite database live under the explicit example state root, `./state`.

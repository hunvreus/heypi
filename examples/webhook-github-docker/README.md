# Webhook GitHub Docker

Advanced webhook automation for GitHub issue diagnosis.

This example receives an issue request over HTTP, uses GitHub API tools for issue context and controlled writeback, and runs repo inspection inside a Docker-backed heypi runtime. `GITHUB_TOKEN` is used only by host-side custom tools; it is not passed into Docker.

## Requirements

- Docker CLI on `PATH`
- Running Docker daemon
- A public GitHub repo the Docker runtime can clone
- Optional `GITHUB_TOKEN` for higher GitHub API limits or private issue metadata reads
- Required `GITHUB_TOKEN` if you want the agent to comment on or close issues

The Docker image is pulled on first use if missing:

```bash
docker pull node:22-bookworm
```

## Run

```bash
cd examples/webhook-github-docker
cp .env.example .env
pnpm dev
```

Dev mode starts the loopback local adapter only. Use `POST /dev/messages` to test the agent without webhook secrets. Use `pnpm start` after filling `.env` to run the real webhook adapter.

Required env vars:

```bash
OPENAI_API_KEY=...
HEYPI_WEBHOOK_SECRET=...
HEYPI_GITHUB_REPO=owner/repo
```

Optional env vars:

```bash
GITHUB_TOKEN=...
HEYPI_WEBHOOK_PORT=3000
```

`GITHUB_TOKEN` should have the minimum repo permissions needed. For public read-only diagnosis, omit it. For comment/close writeback, use an issues-scoped token where possible.

## Request

Start the production webhook adapter first:

```bash
pnpm start
```

Use one stable thread id per issue. With `scope: "channel"`, that gives each issue its own scoped Docker workspace and warm container.

```bash
curl -X POST http://127.0.0.1:${HEYPI_WEBHOOK_PORT:-3000}/webhook/github/threads/github-owner-repo-42/messages \
  -H "authorization: Bearer dev-secret-change-me" \
  -H "content-type: application/json" \
  -d '{"user":"github","sync":true,"text":"Diagnose issue #42. Fetch issue details, search duplicate candidates, clone the configured repo if useful, inspect relevant files or tests, and return severity, duplicate candidates, diagnosis, and next action. If tests were run, post a GitHub comment with the result. If this is clearly a duplicate, comment and close it as duplicate."}'
```

For longer requests, omit `sync: true`. The response includes a `threadId` and `runId`, then you can check status:

```bash
curl http://127.0.0.1:${HEYPI_WEBHOOK_PORT:-3000}/webhook/github/threads/github-owner-repo-42/runs/<runId> \
  -H "authorization: Bearer dev-secret-change-me"
```

## Runtime Behavior

The first runtime command may be slower while Docker starts the scoped container. Subsequent commands in the same scope reuse it until the 10-minute idle timeout.

The example uses `node:22-bookworm` so repo diagnosis can run common Node.js project commands. It also mounts persistent npm and pnpm caches under `./workspace/cache`, so repeated installs do not start from an empty package cache.

The Docker container gets network access for `git clone` and package installs, but it does not receive `GITHUB_TOKEN`. GitHub reads and writes happen through host-side custom tools:

- `github_issue_get`
- `github_issue_search`
- `github_issue_comment`
- `github_issue_close_duplicate`

The write tools do not ask for interactive approval. Treat this webhook as trusted automation, keep `HEYPI_WEBHOOK_SECRET` private, and use a narrowly scoped `GITHUB_TOKEN`. The write tools fail if `GITHUB_TOKEN` is missing.

To see active containers:

```bash
docker ps --filter label=heypi.runtime=docker
```

The default SQLite database lives under `./state`. Scoped runtime files live under `./workspace`.

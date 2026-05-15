# Slack DevOps

Slack DevOps assistant with runbook search, governed bash, approvals, and a confirmed custom paging tool.

This example uses Slack Socket Mode so it can run locally without a public HTTPS URL.

## Run

```bash
cp examples/slack-devops/.env.example examples/slack-devops/.env
pnpm run dev:slack
```

Required env vars:

```bash
SLACK_BOT_TOKEN=...
SLACK_SIGNING_SECRET=...
SLACK_APP_TOKEN=...
OPENAI_API_KEY=...
HEYPI_APPROVERS=U123456,U234567
HEYPI_SLACK_TEAMS=
HEYPI_SLACK_CHANNELS=
HEYPI_SLACK_USERS=
```

Leave the `HEYPI_SLACK_*` allowlists empty to accept every event Slack delivers. Set comma-separated IDs to restrict which teams, channels, or users may trigger the agent.

This example enables `streaming: true`, so Slack replies are posted as draft messages and edited while Pi emits text. Delivery pacing and rate-limit retries use heypi's defaults.

Check setup:

```bash
pnpm exec heypi slack check --env examples/slack-devops/.env
pnpm exec heypi slack manifest --url https://<host>/slack/events
```

Try:

```text
help
bash echo hello
Search runbooks for latency
Page the API team because latency is above the runbook threshold
```

## Slack HTTP Mode

For production-style Slack HTTP mode, use the commented block in `index.ts`:

```ts
slack({
	botToken: required("SLACK_BOT_TOKEN"),
	signingSecret: required("SLACK_SIGNING_SECRET"),
	mode: "http",
	port: Number(process.env.PORT ?? 3000),
	path: "/slack/events",
	allow: {
		teams: list("HEYPI_SLACK_TEAMS"),
		channels: list("HEYPI_SLACK_CHANNELS"),
		users: list("HEYPI_SLACK_USERS"),
	},
	trigger: "mention",
	reply: "thread",
	streaming: true,
});
```

In Slack app settings, set Event Subscriptions and Interactivity URLs to `https://<host>/slack/events`, or to the custom `path` you configured.

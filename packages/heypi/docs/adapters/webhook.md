# Webhook

The webhook adapter exposes a JSON HTTP interface for trusted systems. Use it when another service should start or continue heypi threads without going through Slack, Discord, or Telegram.

Webhook registers routes on heypi's shared Node HTTP listener when top-level [`http`](../configuration/http.md) is configured. It can also run a standalone listener from adapter config, but most apps should use the shared listener.

For a runnable advanced example, see [`examples/webhook-github-docker`](https://github.com/hunvreus/heypi/tree/main/examples/webhook-github-docker).

## Options

`webhook()` accepts webhook-specific HTTP options.

| Option | Required | Description |
| --- | --- | --- |
| `secret` | Yes | Shared secret required for request auth. |
| `name` | No | Adapter name. Also controls the default route prefix: `/webhook/{name}`. Defaults to `webhook`. |
| `path` | No | Custom route base. Requires `unsafePathOverride: true`. |
| `unsafePathOverride` | No | Required when overriding the default path. |
| `host` | No | Host constraint for registered routes, or standalone bind host. |
| `port` | No | Port for standalone mode, or route constraint for shared HTTP. Required for standalone mode. |
| `syncTimeoutMs` | No | Maximum wait time for `sync: true` requests. |
| `maxBodyBytes` | No | Maximum request body size. Defaults to `1_000_000`. |
| `maxInFlight` | No | Maximum concurrent webhook runs. Defaults to `32`. |
| `replyHosts` | No | Allowed callback hosts for async `replyUrl` delivery. Required when using `replyUrl`. |

Webhook callers provide the actor with the request `user` field. They can also provide `threadId` and `data` depending on the route and integration.

## Setup

### Shared listener setup

1. Configure top-level [`http`](../configuration/http.md).
2. Add `webhook()` to `createHeypi({ adapters: [...] })`.
3. Set a long random secret.
4. Put the route behind your normal gateway, proxy, auth, and rate limiting when external callers can reach it.

There is no provider app or manifest.

### Standalone setup

Use adapter-level `host` and `port` only when the webhook should own its own HTTP server:

```ts
webhook({
	secret: process.env.HEYPI_WEBHOOK_SECRET!,
	host: "127.0.0.1",
	port: 3000,
});
```

Do not combine standalone webhook servers with top-level `http` unless you intentionally want separate listeners.

## Config

```ts
createHeypi({
	state: { root: "./state" },
	http: { host: "127.0.0.1", port: 3000 },
	adapters: [
		webhook({
			name: "internal",
			secret: process.env.HEYPI_WEBHOOK_SECRET!,
			replyHosts: ["internal.example.com"],
		}),
	],
});
```

Common environment variables:

| Variable | Required when | Description |
| --- | --- | --- |
| `HEYPI_WEBHOOK_SECRET` | Always | Shared secret checked against `authorization: Bearer ...` or `x-heypi-secret`. |

For app-wide config such as `http`, `state`, `runtime`, and `agent`, see [Configuration](../configuration/index.md).

## Routes

Routes are name-derived by default:

```text
POST /webhook/{name}
POST /webhook/{name}/messages
POST /webhook/{name}/threads/:threadId/messages
GET  /webhook/{name}/threads/:threadId/runs/:runId
```

The base route `POST /webhook/{name}` is an alias for `/messages`.

Message requests are async-first and return `202` while the turn runs. Pass `sync: true` for short requests, or `replyUrl` for a callback. Callback hosts must be listed in `replyHosts`.

Start a thread:

```bash
curl -X POST http://localhost:3000/webhook/internal/messages \
  -H "authorization: Bearer $HEYPI_WEBHOOK_SECRET" \
  -H "content-type: application/json" \
  -d '{"user":"alice@example.com","text":"Start incident review"}'
```

Follow up by posting to `/threads/<threadId>/messages`. Check a run with `/threads/<threadId>/runs/<runId>`.

Requests must include one of:

```text
authorization: Bearer <secret>
x-heypi-secret: <secret>
```

Webhook is inbound-only. It does not implement adapter `send()`, so scheduled jobs cannot target webhook adapters.

## CLI

There is no adapter-specific webhook CLI. Use shared commands:

| Command | Purpose |
| --- | --- |
| `npx @hunvreus/heypi check [--env .env] [--db ./state/heypi.db]` | Validate app config and state access. |
| `npx @hunvreus/heypi approvals list --db ./state/heypi.db` | Inspect pending approvals. |
| `npx @hunvreus/heypi jobs list --db ./state/heypi.db` | Inspect configured jobs. |

# Webhook

The webhook adapter exposes a JSON HTTP interface for trusted systems. Use it when another service should start or continue heypi threads without going through Slack, Discord, or Telegram.

Webhook registers routes on heypi's public Node HTTP listener when top-level [`http`](../configuration/http.md) is configured. It can also run a standalone listener from adapter config, but most apps should use the app listener.

For a runnable advanced example, see [`examples/webhook-github-docker`](https://github.com/hunvreus/heypi/tree/main/examples/webhook-github-docker).

## Options

`webhook()` accepts webhook-specific HTTP options.

| Option | Required | Description |
| --- | --- | --- |
| `secret` | Yes, unless `HEYPI_WEBHOOK_SECRET` or `WEBHOOK_SECRET` is set | Shared secret required for request auth. |
| `name` | No | Adapter name. Also controls the default route prefix: `/webhook/{name}`. Defaults to `webhook`. |
| `path` | No | Custom route base. Requires `unsafePathOverride: true`. |
| `unsafePathOverride` | No | Required when overriding the default path. |
| `host` | No | Host constraint for registered routes, or standalone bind host. |
| `port` | No | Port for standalone mode, or route constraint for the app HTTP listener. Required for standalone mode. |
| `syncTimeoutMs` | No | Maximum wait time for `sync: true` requests. |
| `replyTimeoutMs` | No | Maximum wait time when posting an async `replyUrl` callback. Defaults to `10_000`. |
| `maxBodyBytes` | No | Maximum request body size. Defaults to `1_000_000`. |
| `maxInFlight` | No | Maximum concurrent webhook runs. Defaults to `32`. |
| `replyUrls` | No | Exact allowed callback URLs for async `replyUrl` delivery. Fragments are ignored. Credentials are rejected. |
| `replyOrigins` | No | Allowed callback origins for async `replyUrl` delivery, such as `https://internal.example.com`. Values must be origins without paths, queries, fragments, or credentials. |
| `replyHosts` | No | Legacy allowed callback hosts for async `replyUrl` delivery. Prefer `replyUrls` or `replyOrigins` when possible. |
| `unsafeReplyHttp` | No | Allows `http:` callback URLs. By default, `replyUrl` must use HTTPS. |
| `permissions.approvers` | No | Caller-provided `user` values allowed to list and resolve approvals for this adapter. Groups are not supported. |
| `permissions.admins` | No | Caller-provided `user` values allowed to use approval admin actions for this adapter. Admins inherit approver permissions. |

Webhook callers provide the actor with the request `user` field. They can also provide `threadId` and `data` depending on the route and integration. Body-supplied `threadId` values must not start with `whth_`; that prefix is reserved for server-generated webhook threads.

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
  host: "127.0.0.1",
  port: 3000,
});
```

Do not combine standalone webhook servers with top-level `http` unless you intentionally want separate listeners.

## Config

```ts
createHeypi({
  state: { root: "./state" },
  http: { host: "127.0.0.1", port: Number(process.env.HEYPI_WEBHOOK_PORT ?? 3000) },
  adapters: [
    webhook({
      name: "internal",
      replyOrigins: ["https://internal.example.com"],
    }),
  ],
});
```

Common environment variables:

| Variable | Required when | Description |
| --- | --- | --- |
| `HEYPI_WEBHOOK_SECRET` | Always | Shared secret checked against `authorization: Bearer ...` or `x-heypi-secret`. `WEBHOOK_SECRET` is also accepted for generated apps. |

For app-wide config such as `http`, `state`, `runtime`, and `agent`, see [Configuration](../configuration/index.md).

Webhook callers need a stable URL. Use a fixed port for webhook deployments; `http.port: 0` is intended for local admin or polling/socket-mode chat adapters where no external caller needs to know the port ahead of time.

## Routes

Routes are name-derived by default:

```text
POST /webhook/{name}
POST /webhook/{name}/messages
POST /webhook/{name}/threads/:threadId/messages
GET  /webhook/{name}/threads/:threadId/runs/:runId
```

The base route `POST /webhook/{name}` is an alias for `/messages`.

Message requests are async-first and return `202` while the turn runs. Pass `sync: true` for short requests, or `replyUrl` for a callback. Callback URLs must match `replyUrls`, `replyOrigins`, or `replyHosts`; exact URLs are the strictest option. Exact URL matching ignores fragments but keeps path and query ordering strict. `replyUrl` must use HTTPS unless `unsafeReplyHttp: true` is set. Callback delivery is bounded by `replyTimeoutMs`. `replyUrl` is a delivery capability: heypi uses it for the callback response, but it is not model instruction text.

Start a thread:

```bash
curl -X POST http://localhost:${HEYPI_WEBHOOK_PORT:-3000}/webhook/internal/messages \
  -H "authorization: Bearer $HEYPI_WEBHOOK_SECRET" \
  -H "content-type: application/json" \
  -d '{"user":"alice@example.com","text":"Start incident review"}'
```

Follow up by posting to `/threads/<threadId>/messages`. Check a run with `/threads/<threadId>/runs/<runId>`.

Set `eventId` when the caller may retry the same event. Reusing the same `eventId` in the same stored thread dedupes the inbound turn after the first copy is recorded. If `eventId` is omitted, heypi uses the generated run id, which is unique per request and does not dedupe caller retries.

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
| `heypi doctor --boot [--env .env] [--db ./state/heypi.db]` | Run static diagnostics plus env and state checks. |
| `heypi approvals list --db ./state/heypi.db` | Inspect pending approvals. |
| `heypi jobs list --db ./state/heypi.db` | Inspect configured jobs. |

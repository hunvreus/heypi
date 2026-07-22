# Admin and audit

The optional admin HTTP surface exposes health, active work, cancellation, conversation records, Pi
sessions, schedules, and secret submission.

```ts
const agent = loadAgent("./agent", {
	admin: {
		host: "127.0.0.1",
		port: 4321,
		path: "/admin",
	},
});
```

Admin is disabled by default. Loopback binds may run without authentication for local development.
Non-loopback binds require `token`. Wildcard binds such as `0.0.0.0` also require `hosts`, an
explicit HTTP Host allowlist.

```ts
admin: {
	host: "0.0.0.0",
	hosts: ["agent.internal.example"],
	token: process.env.HEYPI_ADMIN_TOKEN,
}
```

Clients authenticate with `Authorization: Bearer <token>` or `X-Heypi-Admin-Token`.

## Endpoints

- `GET /admin/health`
- `GET /admin/jobs`
- `POST /admin/jobs/cancel`
- `GET /admin/conversations`
- `GET /admin/conversations/:key`
- `GET /admin/pi-sessions/:key`
- `GET /admin/pi-sessions/:key/:id`
- `GET /admin/schedules`
- `POST /admin/schedules/run`
- `GET /admin/secret`
- `POST /admin/secret`

The cancel endpoint accepts `{ "scope": "active" | "queued" | "all", "reason": "..." }`. The
schedule endpoint accepts `{ "id": "reports/weekly" }`.

## Audit ownership

heypi conversation logs are the canonical authorization and routing ledger. Pi session JSONL is the
execution trace. Reduced approval annotations in Pi are for correlation and are not authoritative.

Use `listAuditConversations()` and `readAuditConversation()` rather than parsing internal paths.
The admin UI is intentionally operational and local-first; it is not a hosted control plane.

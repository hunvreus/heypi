# TODO

## Todo and memory extensions

- Continue hardening the built-in todo Pi extension.
  - Current implementation owns full-list state, strict transitions, automatic advancement, stable
    status characters, active timestamps, final reconciliation, and Pi-session replay.
  - Add a stale-update reminder only if real usage still shows several meaningful tool calls without
    a todo update after the stricter tool contract.
  - References:
    - `/Users/hunvreus/Workspace/_sandbox/rpiv-mono/packages/rpiv-todo`
    - `/Users/hunvreus/Workspace/_sandbox/pi-tasks`
- Continue hardening the built-in memory Pi extension only where real usage requires it.
  - Current implementation owns curated add/replace/remove/search, adapter and conversation scopes,
    user-profile records, source metadata, bounded context recall, and credential rejection.
  - Writes are immediately durable, so there is no buffered state to flush during compaction or
    shutdown.
  - Consider semantic retrieval or background extraction only after lexical recall and explicit
    writes prove insufficient.
  - References:
    - `/Users/hunvreus/Workspace/_sandbox/pi-hermes-memory`
    - `/Users/hunvreus/Workspace/_sandbox/remnic/packages/plugin-pi`
- Completed reference pass:
  - `/Users/hunvreus/Workspace/_sandbox/rpiv-mono/packages/rpiv-todo`
  - `/Users/hunvreus/Workspace/_sandbox/pi-tasks`
  - `/Users/hunvreus/Workspace/_sandbox/pi-hermes-memory`
  - `/Users/hunvreus/Workspace/_sandbox/remnic/packages/plugin-pi`

## Runtime providers

- Harden runtime-backed Pi core tool operations for `bash`, `read`, `write`, `edit`, `find`,
  `grep`, and `ls`.
  - Host file tools are workspace-constrained.
  - Host bash starts in the workspace but is not sandboxed.
  - Docker owns all exposed core tools without host fallback.
- Add separate runtime packages:
  - `@hunvreus/heypi-runtime-gondolin`
  - `@hunvreus/heypi-runtime-just-bash`
  - `@hunvreus/heypi-runtime-vercel`
  - `@hunvreus/heypi-runtime-cloudflare`
- Treat runtime `env` as model-visible and unsafe for secrets.
  - Document env as configuration only, not credential isolation.
- Add secret-safe runtime capabilities after provider execution exists.
	- Vercel Sandbox: map host-scoped secret brokers to native firewall credential brokering.
	- Cloudflare Sandbox: map host-scoped secret brokers to the outbound Worker/proxy model.
	- Gondolin: map host-scoped secret brokers to Gondolin HTTP hooks.
	- Docker: investigate egress proxy support for HTTP APIs and a Git credential-helper adapter for Git over HTTPS.
	- just-bash: prefer trusted-side tools; do not promise network-level secret brokering.
- Keep raw runtime secret exposure as an explicit opt-in only after the provider API can label it honestly.

## Connections and credentials

- Add trusted-side connection/tool helpers for common external systems before exposing runtime secrets.
  - GitHub: issue/PR/check operations with token kept in the heypi process.
  - Generic OpenAPI/MCP: connection definitions with trusted-side token/header resolution.
- Do not add a generic top-level secret DSL until there is a concrete consumer boundary.
- Current encrypted secret ingress is trusted-side only.
  - `chat_request_secret` sends a browser encryption link.
  - `/admin/secret` serves the static encrypt page and accepts encrypted replies.
  - Pasted `!secret:<id>:<payload>` replies are intercepted before Pi sees them.
  - Secrets are stored encrypted at rest under heypi state, not under `/workspace`.
- Still missing: runtime credential brokering, trusted GitHub/OpenAPI consumers, rotation/expiry UI, and hosted `heypi.dev/secret` deployment.

## Chat attachments

- `chat_attach` now sends runtime-workspace file references back through the active adapter.
  - Paths are validated against `/workspace` or `/shared`.
  - Slack, Discord, and Telegram upload local files when possible.
- Inbound Slack, Discord, and Telegram attachments are materialized into the conversation workspace
  before the turn is queued.
  - Still missing: richer previews and adapter-specific retry/rate-limit handling.

## Scheduling

- Plan: [`packages/heypi/docs/scheduling.md`](packages/heypi/docs/scheduling.md)
- Add agent heartbeats only after durable scheduled jobs exist and the execution scope is explicit.
  - Reuse the scheduled-job runner rather than building a second scheduler.
  - Decide whether a heartbeat is agent-scoped, adapter-scoped, or opt-in per conversation; do not
    fan out across every channel and DM by default.
  - Define the shared state a non-conversation heartbeat may inspect and the trusted destinations it
    may notify.
  - Support conditional no-op completion with no outbound delivery while retaining run audit logs.

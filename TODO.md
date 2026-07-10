# TODO

## Todo and memory extensions

- Continue hardening the built-in todo Pi extension.
  - Current implementation owns task state, valid actions, stable status characters, active timestamps,
    and turn lifecycle settlement.
  - Future work: make state replayable from Pi/session events if Pi exposes a cleaner event source.
  - References:
    - `/Users/hunvreus/Workspace/_sandbox/rpiv-mono/packages/rpiv-todo`
    - `/Users/hunvreus/Workspace/_sandbox/pi-tasks`
- Rebuild memory as a Pi extension before adding learning/consolidation behavior.
  - Keep explicit tools for store/search.
  - Add Pi hooks only where they are Pi-native: context recall, observe turn/message events, session shutdown flush, and compaction coordination.
  - Fence recalled memory as reference context, not instructions.
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
- Add encrypted user-submitted secret storage later if chat/admin secret submission returns.
  - `chat_request_secret` now asks the active chat user for an encrypted `pi.dev/secret` reply.
  - Encrypted replies are intercepted before audit ingestion.
  - Values are stored as `.secrets/<name>` in the runtime workspace, and Pi receives only a redacted storage notice.
  - Still missing: trusted encrypted storage, runtime credential brokering, and admin UX.
  - Store encrypted at rest with a key outside SQLite.
  - Redact values in audit logs, tool results, and adapter output.

## Chat attachments

- Add a real `chat_attach` tool only after runtime files can be safely bridged back to adapter uploads.
  - Current outgoing attachments render as text links/paths in Slack, Discord, and Telegram.
  - Do not claim arbitrary `/workspace` runtime paths are uploadable until each runtime exposes a read/export boundary.

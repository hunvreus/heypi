# TODO

## Slack activity

- Consider a Slack-specific status formatter if fixed `Thinking...` and `Working...` labels prove
  insufficient. Keep it adapter-local and map normalized lifecycle events to status text; do not
  restore a generic progress API.

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
- Still missing:
  - A trusted tool/helper API to read a named secret for custom tools without exposing it to Pi.
  - Runtime credential brokering for one command/session without writing secrets into `/workspace`.
  - Git credential-helper support backed by stored secrets.
  - Missing-secret flow: request secret, wait for submission, then resume or retry the blocked work.
  - Rotation/expiry UI and hosted `heypi.dev/secret` deployment.
- Add OAuth and trusted-side credential brokering only through concrete connection or runtime-provider
  boundaries. Keep credentials out of model-visible prompts, tool inputs, workspaces, and process
  environments.

## Agent-created skills

- Investigate a Hermes-style skill creation workflow as an optional capability, likely starting in an
  example rather than core.
  - Reference: `/Users/hunvreus/Workspace/_sandbox/hermes-agent/tools/skill_manager_tool.py`
  - Hermes supports agent-managed `create`, `edit`, `patch`, `delete`, supporting files, and security
    scanning for skills written under `~/.hermes/skills/`.
  - Decide whether heypi should provide this as a bundled example skill/tool, an optional package, or
    core product surface after the regular skill loading path is stable.

## Chat attachments

- `chat_attach` now sends runtime-workspace file references back through the active adapter.
  - Paths are validated against `/workspace` or `/shared`.
  - Slack, Discord, and Telegram upload local files when possible.
- Inbound Slack, Discord, and Telegram attachments are materialized into the conversation workspace
  before the turn is queued.
  - Still missing: configurable file-size and media-type policies, allowed-host restrictions for
    remote files, richer previews, and adapter-specific retry/rate-limit handling.

## Admin and audit

- Expand the local admin and audit surface only where operational use requires it.
  - Add structured schedule run history and filtering.
  - Add telemetry export hooks and correlation IDs across adapter events, Pi turns, tool calls, and
    schedule runs.
  - Add eval artifacts and captured event streams for reproducible failures.
  - Consider durable event streaming, step-level replay, and crash recovery only with a runtime that
    can provide those guarantees; do not duplicate Pi's transcript locally.

## Channel breadth

- Add channels based on concrete product demand rather than framework parity.
  - Candidates: Teams, GitHub, Linear, Twilio, and a first-party web client.
  - Extend the existing webhook adapter or add a custom HTTP/WebSocket channel contract only when a
    real integration needs behavior that the normalized adapter interface cannot express.

## Scheduling

- Cron schedules are implemented as code-owned modules; see
  [`packages/heypi/docs/scheduling.md`](packages/heypi/docs/scheduling.md).
- Add intervals, one-shot jobs, pause/resume, and runtime-managed schedules only when a concrete use
  case needs them.
- Keep heartbeats as ordinary cron schedules. Do not add a second scheduler or fan out across every
  conversation by default.
- Add distributed claims only when heypi supports multiple workers against one state store.

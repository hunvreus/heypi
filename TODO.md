# TODO

## Soon

- Add a Cloudflare Containers deployment path.
	- Treat Containers as restartable Node/container mode, not a pure Worker rewrite.
	- Add a Worker front door that routes signed HTTP adapter traffic to one or more explicit container instances.
	- Decide the durable `Store` backend for container mode; do not rely on local SQLite surviving container sleep unless it is on a platform-supported persistent filesystem with the required locking and fsync semantics.
	- Document the required durable workspace mount for Pi sessions, attachments, memory, skills, runtime secret files, and generated artifacts.
	- Document Cloudflare's FUSE/R2 or S3-compatible mount path as the expected workspace durability layer for Containers.
	- Make startup, shutdown, lock recovery, scheduler recovery, and rolling deploy behavior tolerate container sleep, restart, and fresh disks.
	- Keep Slack Socket Mode, Discord gateway, and Telegram polling in container mode; use Worker ingress only for HTTP/webhook paths.
	- Add container health/readiness checks, status hooks, and operational docs for logs, SSH/debug access, image rollout, and instance IDs.
- Add provider-specific deployment guides.
	- Cloudflare Containers: Worker front door, durable `Store`, workspace mounted through FUSE/R2 or S3-compatible storage, and container lifecycle operations.
	- Fly.io: persistent volume-backed state/workspace directories and process health checks.
	- VPS/Docker: bind-mounted state/workspace directories, backups, and systemd/container restart behavior.
	- Kubernetes: PVC-backed state/workspace directories, single-owner locking, probes, and rollout guidance.
- Bring back useful experiment learnings without changing the Node/container-first architecture.
	- Keep adapter and route handlers thin; move validation, persistence, delivery, and approval behavior behind small service boundaries.
	- Audit HTTP adapters and extend fast acknowledgement/background processing only where Slack HTTP, Telegram webhooks, or generic webhooks still block on long work.
	- Add blob/file spillover for large call stdout/stderr, tool logs, attachments, and generated artifacts; keep DB rows to previews, metadata, and blob refs.
	- Design encrypted secret persistence before making pending secret requests durable; do not persist request private keys or plaintext secret values in generic stores.
	- Decide whether custom tool `ToolContext` should expose a secret-request capability so trusted tools can ask users for credentials without importing internal `Secrets`.
	- Add a dedicated outbound delivery-attempt ledger only if current message state and delivery queue cannot answer sent, failed, retried, ambiguous outcomes, provider message ids, and attempts.
	- Audit existing stale turn/call/lock recovery and document gaps before adding new recovery state.
	- Document adapter transport modes without changing the default UX: Discord gateway is the normal chat path, Slack supports socket/http, and Telegram supports webhook/polling.
- Add operator status and audit commands.
	- Keep existing `check`, provider diagnostics, `approvals`, and `jobs` commands.
	- Add app health/status that reports store access, migration state, runtime root, adapter config, scheduler readiness, active turns, locks, queued follow-ups, pending approvals, and due jobs.
	- Add audit views for failed turns, blocked commands, approval decisions, long-running calls, and recent delivery failures.
- Tighten runtime provider operations.
	- Add CLI commands for runtime provider `status`, `stop`, and `restart` once provider management stabilizes.
	- Add direct tests for provider-backed file/search behavior against real Docker/Gondolin when CI can run those dependencies.
- Review scoped-skill resources.
	- Decide whether scoped skills should remain single-file `SKILL.md` entries or support scoped resource files.
	- If resource files are added, define safe paths, size limits, write/delete policy, prompt loading rules, and whether resource mutation needs separate approval.
- Extend GitHub webhook automation.
	- Decide whether to add labels, branches, or pull requests.
	- Keep write-side GitHub tokens in host-side custom tools, not runtime containers.
- Add cross-thread recall.
	- Keep Pi responsible for active-session context, branching, and compaction.
	- Add heypi-level search across stored chats outside the current thread/context window.
	- Return compact, source-linked summaries over prior chats, jobs, approvals, and resolved incidents.
- Add browser and web tools as an optional package.
	- Start with local Chrome/CDP or local browser automation before paid cloud providers.
	- Include navigation, accessibility snapshot, click/type, screenshot, extraction, web fetch, and web search.
	- Keep logged-in browser use explicit and separate from plain HTTP fetch/search.
- Add email approval transport.
	- Treat email as an approval delivery channel, not just a chat adapter.
	- Decisions should write to the existing approval store and resume the original turn.
	- Include signed, expiring approve/reject links and enough context for audit.

## Later

- Add guided setup CLI.
	- `heypi init` should scaffold local app files, `.env.example`, agent folder, workspace folder, and provider snippets.
	- Keep provider-specific helpers such as Slack manifest generation separate from local app scaffolding.
- Review cleanup candidates before implementation.
	- Add shared test helpers for repeated temp roots, temp SQLite stores, cleanup, fake agents, fake runtimes, fake delivery queues, and common adapter assertions.
	- Add focused runtime file-tool tests before changing runtime behavior: read offsets, write limits, edit uniqueness, grep scan/file limits, find patterns, symlink/path escape behavior, aborts, and binary/large-file failures.
	- Add focused adapter tests before changing adapter behavior: progress update/stop behavior, skipped first chunks after streaming/progress, private replies, stale approvals, approval replacement, attachments, and provider-specific mention handling.
	- Split `create-heypi/src/index.ts` only when touching scaffolder generation or when file size blocks maintenance.
- Extend approval policy controls.
	- Add chat/admin listing for active approval bypasses.
	- Add durable exact allow rules for known-safe tool calls, with a way to list and revoke them.
	- Show effective approval policy in admin/CLI, including adapter-scoped approvers, admins, expiry, active bypasses, durable allow entries, and command/tool confirmation rules.
	- Bind approvals to the exact tool call input before execution; include tool name, params hash, runtime scope, and bash cwd/env where applicable.
- Review bot-to-bot loop controls.
	- `allow.bots` permits peer bot messages; heypi drops its own bot identity but does not prevent chains where another bot auto-replies to heypi output.
	- Consider provider-specific loop metadata, hop/depth limits, or cooldowns only if real integrations show loops.
- Add more adapters.
  - Teams.
  - Email.
- Document trusted MCP usage through Pi extensions.
  - MCP is not built into Pi core.
  - heypi should only load preapproved MCP extensions.
  - First-class MCP config, tool filtering, and MCP-specific approval policy can come later if needed.

## Deferred

- Approval crash replay.
  - Persist enough pending approval context to resume or safely mark stale approvals after process crash.
- Distributed delivery limiter.
  - Revisit only if multi-replica deployments hit provider-wide rate limits.
- Pure Cloudflare Worker architecture.
  - Revisit only after Container mode is proven and Pi/session/runtime storage boundaries are stable.
  - Worker-native mode still needs D1/DO/R2 storage, Worker-safe package exports, Queue/DO delivery retries, and no-shell or external sandbox runtime behavior.

## Won't Do For Now

- Letting agents install arbitrary MCP servers at runtime.
- Broad bot-side admin/config mutation.

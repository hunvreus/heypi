# TODO

## Now

- Prepare the next release.
	- Treat the approval permission move and native command changes as the main release notes.
	- Include migration notes for configs that still use root `approval.approvers` or `approval.admins`.
	- Run full workspace checks before tagging.
- Add adapter config runtime validation.
	- Validate Slack, Discord, Telegram, and webhook built-in config shapes at adapter construction.
	- Reject stale or unknown built-in adapter keys where safe.
	- Keep custom adapters responsible for their own validation.
	- Add focused tests for stale keys, invalid command names, and adapter-specific config errors.
- Add approval crash replay coverage.
	- Add a regression test for restart while approval is pending, then approve after restart.
	- Fix any gaps for bash calls, registered custom tools, Pi continuation state, and stale pending approvals.
- Extend approval policy visibility and controls.
	- Add chat/admin listing for active approval bypasses.
	- Show effective approval policy in admin/CLI, including adapter-scoped approvers, admins, expiry, active bypasses, and command/tool confirmation rules.
	- For one-time approvals only, verify the pending call still matches the approved call before execution.
- Add operator status command.
	- Keep existing `check`, provider diagnostics, `approvals`, and `jobs` commands.
	- Add app health/status that reports store access, migration state, runtime root, adapter config, scheduler readiness, active turns, locks, queued follow-ups, pending approvals, and due jobs.
- Add Telegram webhook mode.
	- Keep polling as the local/dev path.
	- Register a shared HTTP route for Telegram updates and acknowledge provider requests before long agent work.
	- Add setup docs or CLI helpers for `setWebhook` and `deleteWebhook`.
	- Register native bot commands with `setMyCommands`.
	- Document that one bot token cannot use polling and webhook at the same time.

## Next

- Harden the Cloudflare Containers deployment path.
	- Treat Containers as restartable Node/container mode, not a pure Worker rewrite.
	- Add a Worker front door that routes signed HTTP adapter traffic to one or more explicit container instances.
	- Decide the durable `Store` backend for container mode; do not rely on local SQLite surviving container sleep unless it is on a platform-supported persistent filesystem with the required locking and fsync semantics.
	- Make startup, shutdown, lock recovery, scheduler recovery, and rolling deploy behavior tolerate container sleep, restart, and fresh disks.
	- Keep Slack Socket Mode, Discord gateway, and Telegram polling in container mode; use Worker ingress only for HTTP/webhook paths.
	- Add container health/readiness checks, status hooks, and operational docs for logs, SSH/debug access, image rollout, and instance IDs.
- Add provider-specific deployment guides.
	- Fly.io: persistent volume-backed state/workspace directories and process health checks.
	- VPS/Docker: bind-mounted state/workspace directories, backups, and systemd/container restart behavior.
	- Kubernetes: PVC-backed state/workspace directories, single-owner locking, probes, and rollout guidance.
- Add operator audit views.
	- Add audit views for failed turns, blocked commands, approval decisions, long-running calls, and recent delivery failures.
- Add transcript recall.
	- Keep Pi responsible for active-session context, branching, and compaction.
	- Add heypi-level search across persisted DB messages and Pi JSONL sessions outside the current thread/context window.
	- Add conversation hydration for existing provider conversations: when the bot is invited, first mentioned, or attached to an existing channel/thread, fetch recent provider history where APIs and permissions allow it.
	- Return compact, source-linked summaries over prior chats, jobs, approvals, and resolved incidents.
- Add blob/file spillover for large stored output.
	- Spill large call stdout/stderr, tool logs, attachments, and generated artifacts to blobs/files.
	- Keep DB rows to previews, metadata, and blob refs.
- Design durable secret request support.
	- Design encrypted secret persistence before making pending secret requests durable.
	- Do not persist request private keys or plaintext secret values in generic stores.
	- Decide whether custom tool `ToolContext` should expose a secret-request capability so trusted tools can ask users for credentials without importing internal `Secrets`.

## Later

- Tighten runtime provider operations.
	- Add CLI commands for runtime provider `status`, `stop`, and `restart` once provider management stabilizes.
	- Add direct tests for provider-backed file/search behavior against real Docker/Gondolin when CI can run those dependencies.
- Review scoped-skill resources.
	- Decide whether scoped skills should remain single-file `SKILL.md` entries or support scoped resource files.
	- If resource files are added, define safe paths, size limits, write/delete policy, prompt loading rules, and whether resource mutation needs separate approval.
- Extend GitHub webhook automation.
	- Decide whether to add labels, branches, or pull requests.
	- Keep write-side GitHub tokens in host-side custom tools, not runtime containers.
- Add a memory provider plugin surface.
	- Keep scoped file memory as the default.
	- Let optional plugins provide semantic memory, profile/user memory, or external recall providers without coupling them to core chat storage.
	- Start only after transcript recall proves the missing use cases.
- Add browser and web tools as an optional package.
	- Start with local Chrome/CDP or local browser automation before paid cloud providers.
	- Include navigation, accessibility snapshot, click/type, screenshot, extraction, web fetch, and web search.
	- Keep logged-in browser use explicit and separate from plain HTTP fetch/search.
- Add email approval transport.
	- Treat email as an approval delivery channel, not just a chat adapter.
	- Decisions should write to the existing approval store and resume the original turn.
	- Include signed, expiring approve/reject links and enough context for audit.
- Add email adapter.
	- Treat this as a chat/inbound adapter, separate from email approval delivery.
- Add an outbound delivery-attempt ledger if needed.
	- Add only if current message state and delivery queue cannot answer sent, failed, retried, ambiguous outcomes, provider message ids, and attempts.
- Review cleanup candidates before implementation.
	- Add shared test helpers for repeated temp roots, temp SQLite stores, cleanup, fake agents, fake runtimes, fake delivery queues, and common adapter assertions.
	- Add focused runtime file-tool tests before changing runtime behavior: read offsets, write limits, edit uniqueness, grep scan/file limits, find patterns, symlink/path escape behavior, aborts, and binary/large-file failures.
	- Add focused adapter tests before larger adapter behavior changes: progress update/stop behavior, skipped first chunks after streaming/progress, private replies, stale approvals, approval replacement, attachments, and provider-specific mention handling.
	- Split `create-heypi/src/index.ts` only when touching scaffolder generation or when file size blocks maintenance.
- Review bot-to-bot loop controls.
	- `allow.bots` permits peer bot messages; heypi drops its own bot identity but does not prevent chains where another bot auto-replies to heypi output.
	- Consider provider-specific loop metadata, hop/depth limits, or cooldowns only if real integrations show loops.
- Add more adapters.
	- Teams.
- Document trusted MCP usage through Pi extensions.
	- MCP is not built into Pi core.
	- heypi should only load preapproved MCP extensions.
	- First-class MCP config, tool filtering, and MCP-specific approval policy can come later if needed.

## Won't do for now

- Letting agents install arbitrary MCP servers at runtime.
- Broad bot-side admin/config mutation.
- Running Telegram polling and webhook delivery for the same bot token at the same time.

# TODO

## Soon

- Bring back useful experiment learnings without changing the Node/container-first architecture.
	- Keep adapter and route handlers thin; move validation, persistence, delivery, and approval behavior behind small service boundaries.
	- Audit HTTP adapters and extend fast acknowledgement/background processing only where Slack HTTP, Telegram webhooks, or generic webhooks still block on long work.
	- Add blob/file spillover for large call stdout/stderr, tool logs, attachments, and generated artifacts; keep DB rows to previews, metadata, and blob refs.
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
- Extend approval policy controls.
	- Move toward a canonical permission config such as `permissions.approvers` and `permissions.admins` with adapter-qualified actor ids like `slack:U123` and `discord:456`.
	- Add a setting to skip approval flow when the requester is also an approver.
	- Support approval decisions such as allow once, always allow, and deny.
	- Persist always-allow decisions as durable policy entries with a way to list and revoke them.
	- Show effective approval policy in admin/CLI, including approvers, expiry, durable allow entries, and command/tool confirmation rules.
	- Bind approvals to the exact tool call input before execution; include tool name, params hash, runtime scope, and bash cwd/env where applicable.
	- Add temporary approval windows, for example accepting similar requests for the next 5 minutes.
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

## Won't Do For Now

- Letting agents install arbitrary MCP servers at runtime.
- Broad bot-side admin/config mutation.

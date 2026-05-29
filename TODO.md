# TODO

## Soon

- Add operator status and audit commands.
  - Keep existing `check`, provider diagnostics, `approvals`, and `jobs` commands.
  - Add app health/status that reports store access, migration state, runtime root, adapter config, scheduler readiness, active turns, locks, queued follow-ups, pending approvals, and due jobs.
  - Add audit views for failed turns, blocked commands, approval decisions, long-running calls, and recent delivery failures.
- Add scoped memory and isolation.
  - Define one scope model for `app`, `adapter`, `channel`, `thread`, and `actor`.
  - Apply scopes consistently to Pi sessions, memory, file tools, attachments, runtime roots, and history search.
  - Keep default behavior conservative: thread session/history, thread memory when enabled, app runtime unless configured narrower.
  - Add scope-aware runtime roots so channels, actors, or threads can get separate workspaces when configured.
  - Add memory tools for explicit read/write/replace/delete with size limits, secret filtering, prompt-injection checks, and approval-gated broad-scope writes.
  - Keep actor memory DM-only by default unless explicitly enabled for group/channel contexts.
## Later

- Add local web admin.
  - Start from `heypi admin --db ./heypi.db --runtime ./workspace`.
  - Bind to `127.0.0.1` by default; require a token for non-local bind.
  - Read-only first: threads, turns, messages, calls, approvals, jobs, scope state, memory files, and Pi session JSONL transcripts.
  - Use `thread.sessionPath` for transcript links; add per-turn Pi entry IDs or JSONL offsets later if deep links are needed.
- Add guided setup CLI.
  - `heypi init` should scaffold local app files, `.env.example`, agent folder, workspace folder, and provider snippets.
  - Keep provider-specific helpers such as Slack manifest generation separate from local app scaffolding.
- Add more adapters.
  - Teams.
  - Email.
- Document trusted MCP usage through Pi extensions.
  - MCP is not built into Pi core.
  - heypi should only load preapproved MCP extensions.
  - First-class MCP config, tool filtering, and MCP-specific approval policy can come later if needed.
- Continue serverless support design.
  - Fetch-compatible adapters.
  - Serverless-compatible store.
  - Scheduler story.
  - Attachment storage story.
  - Static resource loading story.
  - Removal of Node-only runtime assumptions.

## Deferred

- Approval crash replay.
  - Persist enough pending approval context to resume or safely mark stale approvals after process crash.
- Distributed delivery limiter.
  - Revisit only if multi-replica deployments hit provider-wide rate limits.

## Won't Do For Now

- Letting agents install arbitrary MCP servers at runtime.
- Broad bot-side admin/config mutation.

# TODO

## Soon

- Add CLI health/status/audit commands.
  - Health should verify store access, migrations, runtime root, adapter config, and scheduler readiness.
  - Audit should query approvals, calls, failed turns, and blocked commands.
- Add production hardening for `docker-bash`.
  - Optional memory, CPU, read-only mount, and dropped-capability defaults.
  - Image availability check in CLI health.
## Later

- Add local web admin.
  - Start from `heypi admin --db ./heypi.db --runtime ./workspace`.
  - Bind to `127.0.0.1` by default; require a token for non-local bind.
  - Read-only first: threads, turns, messages, calls, approvals, jobs, and Pi session JSONL transcripts.
  - Use `thread.sessionPath` for transcript links; add per-turn Pi entry IDs or JSONL offsets later if deep links are needed.
- Add memory primitives.
  - Conversation summarization.
  - Thread memory notes.
  - Searchable transcript recall.
  - Optional profile/project memory.
  - Explicit tools such as `remember`, `recall`, and `forget`.
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

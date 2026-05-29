# TODO

## Soon

- Add operator status and audit commands.
	- Keep existing `check`, provider diagnostics, `approvals`, and `jobs` commands.
	- Add app health/status that reports store access, migration state, runtime root, adapter config, scheduler readiness, active turns, locks, queued follow-ups, pending approvals, and due jobs.
	- Add audit views for failed turns, blocked commands, approval decisions, long-running calls, and recent delivery failures.
- Tighten runtime provider operations.
	- Add CLI commands for runtime provider `status`, `stop`, and `restart` once provider management stabilizes.
	- Decide whether runtime cold-start/recovery events should be visible in admin activity.
	- Add direct tests for provider-backed file/search behavior against real Docker/Gondolin when CI can run those dependencies.

## Later

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

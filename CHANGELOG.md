# Changelog

This changelog starts with the Pi-native rewrite. Releases through `0.2.0-beta.1` describe the
previous architecture; `0.3.0-beta.0` has no configuration, persistence, or API compatibility
guarantee with those releases.

## [Unreleased]

## [0.3.0-beta.0] - 2026-07-16

### Added

- Added a Pi-native agent host where Pi owns model execution, sessions, compaction, tools,
  extensions, and transcripts.
- Added Slack, Discord, Telegram, webhook, and local adapters with normalized access rules,
  persistent DMs, public root conversations, native threads, and Discord/Telegram reply chains.
- Added tool-scoped approval policies, native approval layouts, durable authorization records,
  adapter-specific approvers, cancellation, timeouts, and restart reconciliation.
- Added host and Docker runtimes in the core package plus separate Gondolin, just-bash, Vercel
  Sandbox, and Cloudflare Sandbox providers.
- Added runtime-backed `bash`, `read`, `write`, `edit`, `find`, `grep`, and `ls` tools with
  `/workspace` and optional `/shared` roots.
- Added inbound attachment staging, outbound `chat_attach`, configurable attachment policies, and
  encrypted secret ingress that stays outside model-visible workspaces.
- Added explicit `chat_history`, todo, and curated memory tools.
- Added code-owned cron schedules with durable claims, restart handling, background Pi runs,
  conversation dispatch, run history, and admin controls.
- Added a local admin and audit surface for active jobs, cancellation, conversations, approvals,
  Pi session records, schedules, and encrypted secret entry.
- Added `heypi create`, `pnpm create heypi`, adapter inspection commands, and the Codex Tag example.

### Changed

- Replaced the previous database-centered runtime with small JSONL coordination logs alongside Pi's
  native session transcripts.
- Moved adapters into `createHeypi()` and agent behavior into code-owned `loadAgent()` options and
  staged Pi resources.
- Made tool approvals opt-in and policy-driven instead of globally configured.
- Replaced generic progress messages with Slack native thread status and Discord/Telegram typing.
- Standardized model-visible runtime paths and Bash execution across built-in runtime providers.
- Made Pi responsible for context-window compaction; older chat context is fetched explicitly.

### Removed

- Removed compatibility with the previous config file, database schema, CLI, admin application,
  runtime packages, and persistence layout.
- Removed the generic progress API, passive chat-context injection, and model-callable progress
  reply tool.
- Removed legacy examples and migration shims that did not fit the Pi-native architecture.

### Security

- Constrained runtime file tools and remote mirrors to declared roots, including symlink checks.
- Added bounded attachment downloads, host/MIME policies, webhook signatures, and non-loopback admin
  authentication requirements.
- Added startup warnings for unrestricted host execution and approval policies without configured
  approvers.
- Kept runtime environment values explicitly model-visible and reserved trusted-side boundaries for
  credential brokering.

[Unreleased]: https://github.com/hunvreus/heypi/compare/0.3.0-beta.0...HEAD
[0.3.0-beta.0]: https://github.com/hunvreus/heypi/compare/0.2.0-beta.0...0.3.0-beta.0

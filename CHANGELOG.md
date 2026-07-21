# Changelog

This changelog starts with the Pi-native rewrite. Version 0.3.0-beta.0 is intentionally
incompatible with the previous beta architecture, configuration, persistence, and package layout.

## [Unreleased]

## [0.3.0-beta.0] - 2026-07-21

### Added

- Pi-native agents with Slack, Discord, Telegram, webhook, and local adapters.
- Host and Docker execution in the core package, plus Gondolin, just-bash, Vercel Sandbox, and
  Cloudflare Sandbox runtime packages.
- Runtime file and shell tools, staged skills, attachments, encrypted secret ingress, todos,
  curated memory, explicit chat history, approvals, cancellation, schedules, audit logs, and local
  administration.
- `heypi create`, `pnpm create heypi`, platform inspection commands, hosted documentation, and the
  Codex Tag example.

### Changed

- Pi now owns model execution, transcripts, compaction, retries, tools, extensions, and session
  state; heypi owns chat transport, policy, resource staging, and coordination.
- Conversation boundaries follow persistent DMs, public root conversations, native threads, and
  Discord or Telegram reply chains.
- Runtime paths are model-visible as `/workspace`, `/shared`, and `/agent`; built-in command
  execution uses Bash where the selected image or provider supports it.
- Webhook requests require stable message ids and return after durable intake instead of waiting for
  model completion.

### Fixed

- Hardened durable message intake, redelivery deduplication, queue dispatch, cancellation, approval
  recovery, schedule claims, and truncated log recovery.
- Prevented duplicate Slack mention handling, unhandled Discord delivery failures, host-path
  disclosure, unsafe wildcard admin hosts, and premature in-memory state changes before persistence.
- Kept native activity and typing indicators synchronized with turn completion, failure, approval,
  cancellation, and queued follow-ups.

### Removed

- Removed the previous database-backed runtime, config format, migration path, CLI and admin
  application, compatibility shims, generic progress API, and obsolete examples.
- Removed the standalone Docker runtime package; Docker execution is now exported by
  `@hunvreus/heypi`.

### Security

- Constrained runtime file access and mirrors to declared roots, bounded attachment downloads, added
  webhook signatures, required authentication for non-loopback admin binds, and warned on
  unrestricted host execution or approval policies without approvers.

[Unreleased]: https://github.com/hunvreus/heypi/compare/0.3.0-beta.0...HEAD
[0.3.0-beta.0]: https://github.com/hunvreus/heypi/releases/tag/0.3.0-beta.0

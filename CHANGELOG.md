# Changelog

## [Unreleased]

### Added
- Initial `heypi` package.
- Code-first `createHeypi` API.
- Pi-backed agent loop via `@mariozechner/pi-coding-agent`.
- Folder-based `agentFrom()` loader for `SYSTEM.md`, `AGENTS.md`, `skills/`, and `extensions/`.
- Slack adapter with Socket Mode and HTTP receiver modes.
- Telegram long-polling adapter.
- Telegram workout example with skills and a local workout logging tool.
- SQLite store for threads, messages, turns, calls, approvals, sessions, and locks.
- Static runtimes: `just-bash`, `guarded-bash`, and `host-bash`.
- Governed Pi-compatible runtime tools: `bash`, `read`, `write`, `edit`, `grep`, `find`, `ls`, and `history`.
- Human approval flow for risky bash calls and confirmed custom tools.
- Provider-native approval, cancel, and status controls for Slack and Telegram.
- Runtime-backed inbound and outbound attachment handling.
- Pretty and JSON console loggers with secret redaction.
- MIT license.

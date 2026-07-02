# Changelog

## [Unreleased]

### Breaking

- Rebuilt heypi as a Pi-native chat adapter shell instead of the previous
  heypi-owned agent harness.
- Removed old runtime, admin, persistence, job, eval, scaffold, and managed
  context machinery from the active package surface.
- Removed broad passive chat history injection. Current turns send only the
  triggering message or the small delta since the last completed trigger; older
  chat is available through the `chat_history` Pi tool.

### Added

- Added file-based agent loading for `instructions.md`, `system.md`,
  `config.json`, `skills/`, `tools/`, and `extensions/`.
- Added Pi-visible resource staging so authored agent files are copied into a
  runtime bundle without leaking host source paths.
- Added Slack, Discord, Telegram, and webhook adapter shells.
- Added approval gating through Pi tool-call events.
- Added built-in Slack approval buttons and provider-neutral approval message
  rendering.
- Added `chat_history` and `chat_reply` Pi tools for explicit older-context
  lookup and sparse model-authored chat updates.

### Not included yet

- Built-in Discord and Telegram approval buttons.
- Memory as a Pi extension.
- Todo/planning as a Pi extension.
- Admin/event mirror.
- Docker/Gondolin runtime providers.
- Cleaned examples.

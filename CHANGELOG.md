# Changelog

## [Unreleased]

### Changed

- Restarted heypi as a clean Pi-native package.
- Added the first clean vertical slice: agent folder loading, resource staging, Pi session wrapper,
  local adapter, channel turn coordination, and approval rendering/extension boundary.
- Added a minimal webhook adapter with HTTP ingress tests.
- Added a minimal Slack Socket Mode adapter shell with message normalization, replies, reactions,
  and approval buttons.
- Added a minimal Discord adapter shell with mention/DM normalization and replies.
- Added a minimal Telegram adapter shell with polling, mention/DM normalization, and replies.
- Added explicit `chat_history` and `chat_reply` Pi tools.
- Added Discord and Telegram approval button payloads and callback handling.
- Added programmable approval policies with `never`, `always`, `once`, `when`, `command`, and
  `default` helpers.
- Clarified staged resource loading: `skills/` and `extensions/` use Pi discovery, while `tools/`
  is treated as an extension-file alias.
- Made local adapter test/embedding messages trigger by default.
- Documented the approval policy context boundary.
- Enabled the default approval extension unless `approvals.enabled` is explicitly false.
- Added an injectable Pi host boundary and app-level chat routing test.
- Added real Slack and Discord card approval layouts.
- Avoid starting Pi sessions for non-triggering adapter messages.
- Avoid sending blank final adapter replies when Pi produces no assistant text.
- Stage `system.md` and `instructions.md` into Pi-native prompt files instead of manually appending
  them in the heypi runtime wrapper.
- Exclude `.heypi` state from staged agent resources so session/channel data is not exposed to Pi as
  authored context.
- Report malformed `config.json` files with the failing path.
- Validate `context.mode` and `approvals.layout` values loaded from `config.json`.
- Report Pi startup failures back to the source chat thread and mark the queued turn failed.
- Treat adapter acknowledgement failures as non-fatal so reaction/typing errors do not drop turns.
- Restore persisted queued turns after restart so accepted work is not lost before Pi runs it.
- Serialize first-time channel creation so concurrent messages share one channel queue and Pi session.
- Export public config and approval integration types from the package entrypoint.
- Added explicit `memory_store` and `memory_search` Pi tools backed by per-conversation JSONL
  storage.
- Added exact-match adapter/account/conversation/user allowlists before Pi work is queued.
- Added Discord and Telegram typing acknowledgements for accepted messages.
- Added normalized inbound thread ids so thread-capable adapters keep separate Pi sessions and reply
  targets.

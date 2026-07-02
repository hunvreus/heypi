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

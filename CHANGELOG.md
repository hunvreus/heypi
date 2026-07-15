# Changelog

## [Unreleased]

### Added

- Added `heypi create` and `pnpm create heypi` with bundled, standalone examples as first-party
  project templates.
- Added code-owned cron schedules discovered from `agent/schedules`, with isolated Pi prompt runs,
  trusted conversation dispatch, persistent occurrence claims and audit records, restart misfire
  handling, overlap protection, bounded run history, and application/admin manual-run controls.

### Changed

- Aligned the Codex Tag template with current heypi defaults for state, workspaces, adapters, admin,
  approvals, and lifecycle handling.
- Removed the redundant adapter-account allowlist and renamed persisted chat audit storage from
  channels to conversations.
- Rebuilt memory as a curated Pi extension with conversation, active-user, and shared destinations,
  per-user profile isolation, explicit add/replace/remove/search tools, bounded relevant context
  recall, source metadata, and optional disablement through `memory: false`.
- Added a startup security warning when an agent omits `runtime` and therefore uses host execution.
- Configured the Codex Tag Docker image to authenticate Git HTTPS operations through GitHub CLI.
- Added configurable per-adapter busy handling with durable queueing, native Pi steering, rejection,
  and adapter event hooks for each outcome.
- Replaced Slack's editable `Thinking...` / `Working...` messages with native
  `assistant.threads.setStatus` activity, including approval pause/resume and restoration after todo
  updates; terminal replies clear status without a separate API call, and the obsolete activity slot
  and adapter message-deletion API were removed.
- Added immediate Slack app-mention reaction acknowledgements before attachment staging, configurable as
  `reaction: false | string` and defaulting to `eyes`.
- Replaced the shared adapter `progress` capability with behavior-specific Slack `status` and
  Discord/Telegram `typing` options; todo rendering is controlled by adapter events.
- Restarted heypi as a clean Pi-native package.
- Added the first clean vertical slice: agent folder loading, resource staging, Pi session wrapper,
  local adapter, channel turn coordination, and approval rendering/extension boundary.
- Added a minimal webhook adapter with HTTP ingress tests.
- Added HMAC-signed webhook ingress support and require a webhook secret for non-loopback hosts.
- Removed passive context selection config; chat history is now explicit through the `chat_history`
  Pi tool.
- Added agent and custom-tool authoring guides.
- Added a minimal Slack Socket Mode adapter shell with message normalization, replies, reactions,
  and approval buttons.
- Added a minimal Discord adapter shell with mention/DM normalization and replies.
- Added a minimal Telegram adapter shell with polling, mention/DM normalization, and replies.
- Added explicit `chat_history` Pi tool and adapter-owned progress updates from Pi events.
- Added Discord and Telegram approval button payloads and callback handling.
- Added programmable, tool-scoped approval policies with `never`, `always`, `once`, `when`, and
  `command` helpers.
- Clarified staged resource loading: `skills/` and `extensions/` use Pi discovery, while `tools/`
  is treated as an extension-file alias.
- Made local adapter test/embedding messages trigger by default.
- Documented the approval policy context boundary.
- Made approvals opt-in per tool instead of installing a global default approval policy.
- Added an injectable Pi host boundary and app-level chat routing test.
- Added real Slack and Discord card approval layouts.
- Avoid starting Pi sessions for non-triggering adapter messages.
- Avoid sending blank final adapter replies when Pi produces no assistant text.
- Stage `system.md` and `instructions.md` into Pi-native prompt files instead of manually appending
  them in the heypi runtime wrapper.
- Exclude `.heypi` state from staged agent resources so session/channel data is not exposed to Pi as
  authored context.
- Removed `config.json` support; agent configuration now lives only in code via `loadAgent()`.
- Report Pi startup failures back to the source chat thread and mark the queued turn failed.
- Restore persisted queued turns after restart so accepted work is not lost before Pi runs it.
- Serialize first-time channel creation so concurrent messages share one channel queue and Pi session.
- Export public config and approval integration types from the package entrypoint.
- Added explicit memory tools backed by bounded Markdown storage.
- Added exact-match conversation/user/group/bot allowlists before Pi work is queued.
- Added Discord and Telegram typing acknowledgements for accepted messages.
- Added normalized inbound thread ids so thread-capable adapters keep separate Pi sessions and reply
  targets.
- Removed heypi-owned `context.maxMessages` and `context.maxChars`; `delta` history now sends the raw
  message delta and leaves compaction to Pi.
- Removed the model-callable `chat_reply` progress tool.
- Changed adapter-owned progress to use platform-native activity driven by adapter events.
- Reworked the built-in `todo` extension around full-list updates, strict task transitions,
  automatic task advancement, Pi-session replay, final reconciliation, active timestamps, and
  honest terminal states; agents can disable it with `todo: false`.
- Captured the Pi-native todo and memory extension direction with references to the reviewed Pi
  extension examples.
- Hardened adapter normalization so Slack system/edit events and empty messages cannot trigger Pi
  turns, while Telegram now detects self messages by bot id and uses forum topic ids for replies.
- Moved adapters out of `loadAgent()` and into `createHeypi()`, and moved allow/activity/approval
  rendering to adapter config.
- Replaced global approval config with tool-scoped approval policies under `tools`.
- Renamed local runtime config from `workspaceDir` to `workspace`.
- Removed public global context/progress/todo/memory config objects; history lookup is explicit via
  `chat_history`, while todo and memory are built-in Pi tools for now.
- Added runtime-backed Pi core tools for host and Docker execution.
- Documented Gondolin, just-bash, Vercel Sandbox, and Cloudflare Sandbox as separate runtime package
  work.
- Documented runtime `env` as model-visible configuration rather than secret isolation.
- Documented the Codex Tag GitHub PR demo path for host runtime with `gh`/`GITHUB_TOKEN`, including
  the secret-leakage caveat.
- Added adapter event hooks for turn/tool/todo/final/error progress, live job inspection, queued and
  active job cancellation, `/admin/jobs`, and adapter-scoped admins/approvers with approval timeouts.
- Added long-running native typing refresh for Discord and Telegram while a Pi turn is active.
- Added a minimal local admin dashboard with live jobs, cancellation controls, and audit channel links.
- Added encrypted secret ingress through `chat_request_secret`, `/admin/secret`, browser-side
  encryption, chat paste interception, and trusted encrypted-at-rest storage.

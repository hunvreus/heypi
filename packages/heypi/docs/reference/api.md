# API reference

Current public API:

- `loadAgent(dir, options)`
- `createHeypi({ agent, logger })`
- `runHeypi(agent)`
- `slack(config)`
- `discord(config)`
- `telegram(config)`
- `webhook(config)`
- `approval(config)`
- `renderApprovalMessage(view)`

`loadAgent()` reads optional `agent/config.json` first, then applies explicit options. The config
file is data-only; models and adapters stay in code.

Default chat context is the current triggering message. Older mirrored chat is available to Pi
through the built-in `chat_history` tool. Pi can send sparse progress updates through the built-in
`chat_reply` tool.

When `approvals` is configured, heypi installs a Pi `tool_call` extension that asks the active
adapter's `requestApproval` hook before selected tools run. Adapter factories expose this as
`onApproval(view)`. Slack also has a built-in approval message with Approve/Reject buttons.

The old store, scheduler, runtime-provider, managed-memory, and heypi-owned tool-loop APIs are not
part of the rewrite surface.

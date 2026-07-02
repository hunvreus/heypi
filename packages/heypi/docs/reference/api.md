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

Default chat context is the current triggering message. Older mirrored chat is available to Pi
through the built-in `chat_history` tool. Pi can send sparse progress updates through the built-in
`chat_reply` tool.

The old store, scheduler, runtime-provider, managed-memory, and heypi-owned tool-loop APIs are not
part of the rewrite surface.

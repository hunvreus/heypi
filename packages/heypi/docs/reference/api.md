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

The old store, scheduler, runtime-provider, managed-memory, and heypi-owned tool-loop APIs are not
part of the rewrite surface.

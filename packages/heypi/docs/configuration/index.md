# Configuration

heypi apps are configured in TypeScript with `createHeypi()`. The config object wires together app state, adapters, the Pi agent, runtime tools, optional features, and operational controls. Most apps use [`loadAgent()`](agent.md) to load the agent instructions, model, tools, context, and Pi extensions from a local folder.

```ts
createHeypi({
  state: { root: "./state" },
  adapters: [slack({ mode: "socket" })],
  agent: loadAgent("./agent", { model: "openai/gpt-5.4-mini" }),
  runtime: { root: workspace("./workspace") },
});
```

The main keys are:

| Key | Required | Details |
| --- | --- | --- |
| `state` | Yes | Durable app state directory. The default store writes SQLite data under `state.root`: threads, messages, calls, approvals, jobs, admin state, and locks. Runtime workspace files live under `runtime.root`, not `state.root`. |
| `adapters` | Yes | Chat or HTTP entrypoints. Built-ins cover Slack, Discord, Telegram, and webhook. Custom adapters can be passed here too. See [Adapters](../adapters/index.md). |
| `agent` | Yes | The Pi agent: model, instructions, optional system override, dynamic context, tools, skills, and Pi extensions. See [Agent](agent.md). |
| `runtime` | Yes | Runtime workspace and execution backend. Runtime-backed default tools include `bash`, file tools, and search tools; `attach` and `history` are default tools too, but are documented with the agent tool surface. No default. See [Runtime](runtime.md) and [Agent tools](tools.md#default-tools). |
| `http` | Only for HTTP routes | Public Node HTTP listener for HTTP adapters and self-hosted secret pages. Defaults to `127.0.0.1:3000`; admin/dev routes use `admin.http`, which defaults to `127.0.0.1:4321`. See [HTTP listener](http.md). |
| `scope` | No | Default sharing boundary for runtime files, memory, skills, secrets, and attachments. Defaults to `channel`. See [Scope](scope.md). |
| `approval` | No | Who can list and resolve approval-gated calls, plus optional expiry. Tool confirmation decides which calls need approval. See [Approvals](approvals.md) and [Agent tools](tools.md#confirmation). |
| `task` | No | Same-thread behavior and cancellation policy while a task is active. Defaults to `busy: "steer"` and `cancel: "initiator"`. See [Task behavior](task.md). |
| `admin` | No | Local admin web panel, auth, login links, and state inspection. Disabled by default. See [Admin](admin.md). |
| `memory` | No | Durable scoped notes the agent can read and update. Disabled by default. See [Memory](memory.md) and [Agent tools](tools.md#managed-tools). |
| `skills` | No | Scoped procedures and runbooks the agent can create, patch, read, and delete. Disabled by default. See [Skills](skills.md) and [Agent tools](tools.md#managed-tools). |
| `secrets` | No | Encrypted browser handoff for sensitive values that should become runtime files. Disabled by default. See [Secrets](secrets.md). |
| `attachments` | No | Inbound files, generated-file delivery, size limits, document conversion, and custom attachment stores. See [Attachments](attachments.md) and the [`attach` tool](tools.md#default-tools). |
| `jobs` | No | Configured cron jobs and heartbeat jobs. Omit to disable scheduling; set `[]` to reconcile and pause previously configured jobs. See [Scheduling](scheduling.md). |
| `store` | No | Custom durable store. Defaults to SQLite under `state.root`. Needed only when you replace the default state backend, usually for multi-instance deployments. See [Custom integrations](../guides/integrations.md#store). |
| `scheduler` | No | Scheduler polling and job lock behavior. Defaults: `pollMs: 30_000`, `lockMs: 600_000`. Most apps should keep them. See [Scheduling](scheduling.md#options). |
| `appLock` | No | Single-process app lock. Enabled by default with `ttlMs: 60_000` and `drainMs: 30_000`. Disable only when deployment ownership is handled elsewhere. See [Deployment](../guides/deployment.md#process-ownership). |
| `messages` | No | User-facing system copy for busy replies, approval errors, cancellation, runtime startup, and generic failures. See [Task behavior](task.md#messages). |
| `logger` | No | Structured logging sink. Defaults to `consoleLogger({ level: "info", format: "pretty" })`; use JSON for log collectors. See [Deployment](../guides/deployment.md#logging). |

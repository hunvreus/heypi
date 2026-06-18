# API

heypi is configured through TypeScript APIs. This page lists the public entrypoints and exported subpaths. See the linked pages for behavior and examples.

## Package exports

| Import | Use |
| --- | --- |
| `@hunvreus/heypi` | Main app API: app lifecycle, adapters, config helpers, tools, runtime workspace helper, SQLite store. See [top-level config types](https://github.com/hunvreus/heypi/blob/main/packages/heypi/src/config.ts). |
| `@hunvreus/heypi/adapter` | Types for custom chat or HTTP adapters, including adapter-local `permissions`. See [Custom integrations](../guides/integrations.md) and [adapter contracts](https://github.com/hunvreus/heypi/blob/main/packages/heypi/src/io/handler.ts). |
| `@hunvreus/heypi/attachments` | Attachment store and processing types. See [Attachments](../configuration/attachments.md) and [attachment contracts](https://github.com/hunvreus/heypi/blob/main/packages/heypi/src/io/attachments.ts). |
| `@hunvreus/heypi/runtime` | Runtime and runtime provider types for custom sandbox providers. See [Runtime](../configuration/runtime.md) and [runtime contracts](https://github.com/hunvreus/heypi/blob/main/packages/heypi/src/runtime/types.ts). |
| `@hunvreus/heypi/store` | Store types for custom durable state backends. See [store contracts](https://github.com/hunvreus/heypi/blob/main/packages/heypi/src/store/types.ts). |

## App lifecycle

| Export | Purpose |
| --- | --- |
| `createHeypi(config)` | Builds a heypi app from code-first config. See [Configuration](../configuration/index.md). |
| `runHeypi(app)` | Starts an app and installs `SIGINT`/`SIGTERM` shutdown handlers. |
| `HeypiApp` | App instance with `start()` and `stop()`. |
| `HeypiConfig` | Top-level config object. See [Configuration](../configuration/index.md) and [source](https://github.com/hunvreus/heypi/blob/main/packages/heypi/src/config.ts). |
| `ApprovalConfig` | Approval policy config: expiry, self-approval, and bypass behavior. Approver/admin identities live on adapter `permissions`. |
| `ApprovalPolicy` | Effective per-adapter approval policy passed to adapters and handlers. |
| `TaskConfig` | Task interaction config, including busy behavior and cancellation policy. See [Task](../configuration/task.md). |
| `CancelPolicy` | Cancellation permission level: `admin`, `approver`, `initiator`, or `allowed`. Admins are always included. |
| `BusyBehavior` | Same-thread busy behavior: `steer`, `followUp`, or `reject`. |

## Agent

| Export | Purpose |
| --- | --- |
| `loadAgent(folder, options)` | Loads `SYSTEM.md`, `SOUL.md`, `AGENTS.md`, `tools/`, `jobs/`, `skills/`, and `extensions/` from a folder. See [Agent](../configuration/agent.md). |
| `loadTools(folder)` | Loads default-exported tools from a folder. File stems become tool names when omitted. |
| `loadJobs(folder)` | Loads default-exported jobs from a folder. |
| `agentFrom(folder, options)` | Compatibility alias for `loadAgent()`. |
| `modelConfig(input)` | Parses a `provider/name` model string into a model config object. |
| `AgentConfig` | Pi agent config: model, prompts, context, tools, skills, and Pi extensions. |
| `AgentContextProvider` | Per-turn context callback type. |

## Adapters

| Export | Purpose |
| --- | --- |
| `slack(config)` | Slack adapter. See [Slack](../adapters/slack.md). |
| `discord(config)` | Discord adapter. See [Discord](../adapters/discord.md). |
| `telegram(config)` | Telegram adapter. See [Telegram](../adapters/telegram.md). |
| `webhook(config)` | JSON HTTP webhook adapter. See [Webhook](../adapters/webhook.md). |

Adapter configs own channel-specific approval identity through `permissions.approvers` and `permissions.admins`.

## Tools

| Export | Purpose |
| --- | --- |
| `defaultTools(config)` | Selects built-in runtime tools such as `bash`, `read`, `write`, `grep`, `ls`, `attach`, and `history`. |
| `coreTools(config)` | Compatibility alias for `defaultTools()`. |
| `defineTool(definition)` | Defines a trusted custom TypeScript tool with `input` and `run`. Supports Zod, TypeBox, and raw JSON Schema input schemas. See [Agent tools](../configuration/tools.md). |
| `tool(definition)` | Compatibility API for custom tools using `parameters` and `execute`. |
| `defineJob(definition)` | Defines a scheduled job for `agent/jobs/` discovery or explicit `jobs` config. |
| `approval` | Helpers for common confirmation policies: `always`, `never`, `when`, and `command`. |
| `commandConfirm(config)` | Builds bash confirmation policy from allow/approve/block patterns. |
| `classifyCommand(command, config)` | Classifies a command against command policy. |
| `ToolContext` | Custom tool context containing the selected scoped runtime and abort signal. |

## Runtime and state

| Export | Purpose |
| --- | --- |
| `workspace(path)` | Resolves a runtime workspace root for local config. |
| `RuntimeConfig` | Runtime selection, root, scope, queue limits, file limits, and provider config. |
| `RuntimeProvider` | Provider lifecycle contract exported from `@hunvreus/heypi/runtime`. See [runtime contracts](https://github.com/hunvreus/heypi/blob/main/packages/heypi/src/runtime/types.ts). |
| `sqliteStore(config)` | Default SQLite-backed store factory. |
| `Store` | Durable state backend contract exported from `@hunvreus/heypi/store`. See [store contracts](https://github.com/hunvreus/heypi/blob/main/packages/heypi/src/store/types.ts). |

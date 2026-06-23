# API

heypi is configured through TypeScript APIs. This page lists the public entrypoints and exported subpaths. See the linked pages for behavior and examples.

## Package exports

| Import | Use |
| --- | --- |
| `@hunvreus/heypi` | Main app API: app lifecycle, adapters, config helpers, tools, runtime workspace helper, SQLite store. See [top-level config types](https://github.com/hunvreus/heypi/blob/main/packages/heypi/src/config.ts). |
| `@hunvreus/heypi/adapter` | Types for custom chat or HTTP adapters, including adapter-local `permissions`. See [Custom integrations](../guides/integrations.md) and [adapter contracts](https://github.com/hunvreus/heypi/blob/main/packages/heypi/src/io/handler.ts). |
| `@hunvreus/heypi/attachments` | Attachment store and processing types. See [Attachments](../configuration/attachments.md) and [attachment contracts](https://github.com/hunvreus/heypi/blob/main/packages/heypi/src/io/attachments.ts). |
| `@hunvreus/heypi/authoring` | Lightweight helpers for discovered authored files under `agent/`: `defineTool`, `defineJob`, `defineEval`, `approval`, and command policy helpers. |
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
| `loadAgent(folder, options)` | Loads `instructions.md`, optional `system.md`, recursive `tools/` and `jobs/`, plus `skills/` and `extensions/` from a folder. See [Agent](../configuration/agent.md). |
| `loadPrompt(path, options)` | Loads a UTF-8 prompt file. Missing files throw unless `optional` is true. |
| `loadTools(folder)` | Loads default-exported tools recursively from a folder. File stems become tool names when omitted. |
| `loadJobs(folder)` | Loads default-exported jobs recursively from a folder. |
| `loadEvals(folder)` | Loads default-exported evals recursively from a folder. |
| `modelConfig(input)` | Parses a `provider/name` model string into a model config object. |
| `DEFAULT_AGENT_ID` | Canonical default durable agent id, currently `default`. |
| `AgentConfig` | Pi agent config: model, instructions, context, built-in tools, authored tools, skills, and Pi extensions. |
| `LoadAgentOptions` | Options accepted by `loadAgent()`, including model, id, builtinTools, tools, jobs, context, skills, and extensions. |
| `LoadPromptOptions` | Options accepted by `loadPrompt()`. |
| `AgentContextProvider` | Per-turn context callback type. |

## Adapters

| Export | Purpose |
| --- | --- |
| `slack(config)` | Slack adapter. See [Slack](../adapters/slack.md). |
| `discord(config)` | Discord adapter. See [Discord](../adapters/discord.md). |
| `telegram(config)` | Telegram adapter. See [Telegram](../adapters/telegram.md). |
| `webhook(config)` | JSON HTTP webhook adapter. See [Webhook](../adapters/webhook.md). |
| `local(config)` | Loopback-only adapter for explicit local HTTP test routes. `heypi dev` installs its own local adapter automatically; most apps do not need to configure `local()` directly. |

Adapter configs own channel-specific approval identity through `permissions.approvers` and `permissions.admins`.

## Default tools

| Export | Purpose |
| --- | --- |
| `defaultTools(config)` | Selects built-in runtime tools such as `bash`, `read`, `write`, `edit`, `grep`, `find`, `ls`, `attach`, and `history`. |
| `DefaultToolsConfig` | Config shape accepted by `defaultTools()`. |
| `DefaultToolName` | String union of built-in runtime tool names accepted by `defaultTools()`. |
| `DefaultToolOption` | Per-tool boolean or config entry accepted by `DefaultToolsConfig`. |
| `DefaultToolDefinition` | Descriptor returned by `defaultTools()` before heypi binds the runtime implementation. |

## Evals

| Export | Purpose |
| --- | --- |
| `defineEval(definition)` | Defines a behavior eval for root `evals/` discovery and `heypi eval` inspection. |
| `evaluateEval(input, result)` | Evaluates text, tool, approval, and custom assertions against a supplied eval result. |
| `EvalConfig` | Eval definition shape: name, prompt, expectations, tags, and timeout. |
| `EvalExpect` | Assertion shape accepted by eval definitions. Supports text, includes, tool, approval, and custom function assertions. |
| `EvalResult` | Result shape evaluated by `evaluateEval()`: text, tools, and approvals. |
| `EvalReport` | Assertion report returned by `evaluateEval()`. |
| `EvalAssertion` | Individual assertion result with `ok`, label, and optional message. |

## Authoring helpers

Import these from `@hunvreus/heypi/authoring` inside `agent/tools/`, `agent/jobs/`, and root `evals/`.

| Export | Purpose |
| --- | --- |
| `defineTool(definition)` | Defines a trusted custom TypeScript tool with `input` and `run`. Supports Zod, TypeBox, and raw JSON Schema input schemas. Zod inputs are parsed before `confirm` and `run`. See [Agent tools](../configuration/tools.md). |
| `defineJob(definition)` | Defines a scheduled job for `agent/jobs/` discovery or explicit `jobs` config. |
| `defineEval(definition)` | Defines a behavior eval for root `evals/` discovery and `heypi eval` inspection. |
| `approval` | Helpers for common confirmation policies: `always`, `never`, `when`, and `command`. |
| `classifyCommand(command, config)` | Classifies a command against command policy. |
| `ToolContext` | Custom tool context containing the selected scoped runtime and abort signal. |

The main `@hunvreus/heypi` entrypoint also exports the authoring helpers for direct config use. Prefer `@hunvreus/heypi/authoring` in discovered modules because `loadAgent()` loads those files during app startup.

## Logging

| Export | Purpose |
| --- | --- |
| `consoleLogger(config)` | Creates the default console logger. Use `format: "json"` for production log collectors. |
| `Logger` | Logging sink contract used by `createHeypi({ logger })`. |
| `Level` | Logger severity level type. |
| `Format` | Console logger output format type. |

## Runtime and state

| Export | Purpose |
| --- | --- |
| `workspace(path)` | Resolves a runtime workspace root for local config. |
| `RuntimeConfig` | Runtime selection, root, scope, queue limits, file limits, and provider config. |
| `RuntimeProvider` | Provider lifecycle contract exported from `@hunvreus/heypi/runtime`. See [runtime contracts](https://github.com/hunvreus/heypi/blob/main/packages/heypi/src/runtime/types.ts). |
| `sqliteStore(config)` | Default SQLite-backed store factory. |
| `Store` | Durable state backend contract exported from `@hunvreus/heypi/store`. See [store contracts](https://github.com/hunvreus/heypi/blob/main/packages/heypi/src/store/types.ts). |

# Changelog

## [Unreleased]

### Breaking
- Changed chat response placement config to use adapter-local `response` objects. Slack `reply` is now `response.placement`, and Slack `replyBroadcast` is now `response.broadcast`; the old keys are not supported.
- Changed `loadAgent()` to default the durable agent id to `default` instead of the agent folder basename. Apps that relied on the old implicit id, such as `agent`, should pass `id` explicitly to keep using existing persisted state.
- Changed `loadAgent()` defaults so built-in runtime tools live under `builtinTools`, authored tools live under `tools`, jobs/tools convention folders are overridden by explicit options, and eval discovery moved from `agent/evals/` to root `evals/`. If you pass `tools` or `jobs`, include `loadTools("./agent/tools")` or `loadJobs("./agent/jobs")` yourself when you still want convention-loaded modules.
- Removed support for legacy `tools: defaultTools()` config. Use `builtinTools: defaultTools()` for built-in runtime tools and `tools` for authored app tools.
- Changed admin/dev HTTP binding to use `admin.http`, defaulting to `127.0.0.1:4321`, instead of sharing the public adapter `http` listener.

### Added
- Added the JS-native authoring APIs `loadAgent`, `defaultTools`, `defineTool`, and `approval`, with Zod input schema support for custom tools.
- Added the `@hunvreus/heypi/authoring` entrypoint for lightweight authored modules under `agent/tools/`, `agent/jobs/`, and `evals/`.
- Added `loadTools`, `loadJobs`, and `defineJob`, with `loadAgent()` discovery for `agent/tools/` and `agent/jobs/`.
- Added `loadPrompt()` for explicit prompt-file loading with optional missing-file handling.
- Added `heypi dev`, `heypi start`, and the loopback-only `local()` adapter for local testing alongside configured adapters.
- Added `defineEval`, `loadEvals`, root `evals/` discovery, and `heypi eval list/show/check` for first-class behavior eval definitions.
- Added `evaluateEval()` for reusable text, tool-call, approval, and custom eval assertions.
- Added `heypi eval run` to run eval assertions against explicit supplied result data.
- Added agent-backed `heypi eval run` mode for running eval prompts through a local Pi-backed heypi handler with isolated temporary state.
- Added `create-heypi --admin` and `--no-admin` flags for non-interactive scaffolding.
- Added optional eval run trace event persistence through `heypi eval run --db`.
- Added persisted trace events for messages, turns, tool calls, approvals, and call traces to support richer run inspection.
- Added persisted model lifecycle trace events for agent turns and approved continuations.
- Added persisted Pi tool lifecycle trace events for agent-backed tool execution.
- Added retry handling for trace event sequence conflicts during concurrent event appends.
- Added admin chat compose for sending local dev messages through the same handler path used by adapters.
- Added admin approval actions that submit approve/deny decisions through the shared handler path.
- Added admin thread actions for submitting cancel/status controls through the shared handler path.
- Added a live pulse to the admin Chats sidebar for pending approvals, running runs, jobs, and refresh time.
- Added an admin Evals page for inspecting loaded eval definitions.
- Added read-only `heypi threads`, `heypi thread`, and `heypi events` commands for inspecting persisted chat and trace state from the CLI.
- Added typed trace event rows to admin thread inspection.
- Added trace events when startup recovery marks interrupted turns and calls as failed.
- Added conventional env defaults for Slack, Discord, Telegram, and webhook adapter credentials.

### Changed
- Removed deprecated public authoring aliases in favor of `loadAgent()`, `defaultTools()`, `defineTool()`, and `approval.command()`.
- Changed `create-heypi` generated adapter wiring to rely on adapter env defaults instead of inline `process.env.*!` credential plumbing.
- Changed `heypi dev` to start configured adapters, enable admin by default when omitted, load `.env.local` after `.env`, and install internal loopback local test routes.
- Changed `heypi start` to load only `.env` and avoid dev-only admin/local route defaults.
- Changed generated apps and examples to omit admin config by default so `heypi dev` owns the local admin behavior.
- Changed `create-heypi` generated README and next steps to separate local model setup from production adapter setup.
- Changed `create-heypi` generated README and next steps to describe `/dev/messages` instead of admin when admin is disabled.
- Changed README, manual setup, generated apps, and examples to use declaration-only app config without a visible `HEYPI_DEV` adapter branch or direct-run guard.
- Changed quickstart setup order to make model auth local-first and provider adapter auth production-only.
- Changed create-heypi docs to list common non-interactive flags, including `--admin` and `--no-admin`.
- Changed `heypi dev` to print an absolute `/dev/messages` URL when the running local HTTP listener can be discovered.
- Changed `loadAgent()` discovery to load nested `tools/` and `jobs/` modules in deterministic relative-path order.
- Changed `heypi eval check` to validate eval names, prompts, tags, timeouts, and assertion shapes instead of only checking for a prompt.
- Changed examples to use `loadAgent()` and `defineTool()` instead of deprecated authoring aliases.
- Changed the Slack DevOps, Telegram Workout, and Webhook GitHub Docker examples to load custom tools from `agent/tools/` discovery instead of wiring authored tools in `index.ts`.
- Changed example READMEs to distinguish `heypi dev` local conveniences from `heypi start` normal runtime startup.
- Changed `create-heypi` generated tool samples to live under `agent/tools/` for discovery instead of top-level `tools/`.
- Changed `create-heypi` generated sample tools to use Zod input schemas and declare `zod` as an app dependency.
- Changed `defineTool()` to parse Zod input before custom `confirm` and `run` handlers.
- Changed `create-heypi` generated apps to export the app by default so `heypi dev` and `heypi start` can load the same config used by direct execution.
- Changed runnable examples to use their own `pnpm dev` scripts instead of root-level example aliases.
- Changed Discord and Telegram response placement config to use `response.placement` plus recent same-actor continuation.
- Changed Discord and Telegram control callbacks to use a shared provider-neutral action parser.
- Changed Slack, Discord, and Telegram progress config handling to use one shared normalization policy.
- Changed Slack, Discord, and Telegram bot allowlist checks to use one shared internal policy helper.
- Changed Slack, Discord, and Telegram actor allowlist matching to use one shared internal policy helper.
- Changed Slack, Discord, and Telegram missing-allow startup warnings to use one shared helper.
- Changed the admin Chats sidebar to group conversations by adapter.
- Changed admin thread pages to default to a summarized conversation view with a URL-backed full log toggle.
- Added an adapter filter to the admin Chats sidebar.
- Fixed admin Chats pagination preserving the adapter filter and added a reset action for active chat filters.
- Fixed trace event storage to redact secrets centrally before persisting event data.
- Added admin eval definition details with full prompt and assertion text.
- Changed built-in adapter env var resolution to use one shared helper.
- Changed CLI and admin eval expectation display to use shared formatting helpers.
- Changed Slack, Discord, and Telegram approval presentation to share provider-neutral title, row, and text helpers.
- Changed internal runtime code and architecture docs to prefer `loadAgent()`, `defaultTools()`, and `defineTool()` terminology.
- Changed remaining internal runtime naming to use `defaultTools()` terminology.
- Changed the public agent loader options type from `AgentFromOptions` to `LoadAgentOptions`.
- Added `DefaultToolName`, `DefaultToolOption`, and `DefaultToolDefinition` as the preferred public type names for `defaultTools()`.
- Changed runtime tests to use `defineTool()` for custom tools.
- Changed the heypi package test script to accept focused Node test file arguments.
- Changed generated app README copy to point first-run users at the local admin/dev interaction path.
- Changed admin trace rows to render model lifecycle events with readable titles and summaries.
- Changed API and tools docs to document only the current authoring path.
- Changed the Slack DevOps example to use the public `approval.command()` helper.
- Changed example app scripts to use `heypi dev` and `heypi start` with default-exported apps.
- Changed `defaultTools()` to use the public `approval.command()` helper internally.
- Added `DefaultToolConfig` and `DefaultToolsConfig` as the preferred public type names for `defaultTools()` config.

### Fixed
- Removed duplicate card wrappers and section descriptions from the admin approvals, jobs, memory, and configuration pages.
- Changed admin thread pages to use one timeline view, remove the conversation/log toggle, and label generic trace rows distinctly from runs.
- Changed admin thread trace teasers to show human-readable lifecycle labels and useful metadata instead of raw event names.
- Changed admin thread activity badges to emphasize Tool, Approval, and Activity buckets and made user messages bordered instead of filled.
- Swapped admin thread message bubble styling so user messages use the accent fill and model messages use a bordered background.
- Changed admin thread compose controls to use an input-group layout with Enter-to-send behavior and icon-only sidebar footer actions.
- Fixed admin thread message bubbles to keep natural left/right widths while sharing the centered compose column.
- Fixed admin thread compose input-group width to fill the same centered column as the timeline.
- Changed admin thread trace labels from generic Activity wording to concrete Message, Turn, Model, Run, Tool, and Approval labels.
- Fixed admin thread context rows so long metadata truncates inside the centered timeline column instead of pushing timestamps past the compose width.
- Fixed admin thread live refresh pinning the page to the bottom while reading earlier messages.
- Fixed admin thread scrolling, view toggle state coverage, and stale Basecoat semantic utilities in generated admin CSS.
- Changed `heypi dev` to run apps under a file watcher so code and admin UI template changes restart automatically during local development.
- Fixed admin thread pages refreshing the selected conversation by replacing the thread panel instead of reloading the full admin document.
- Fixed admin live refresh falling back to a full page reload when both the selected thread and chat sidebar data changed in the same pulse.
- Fixed agent-backed `heypi eval run` missing-model errors to fail before constructing the local eval runtime.
- Fixed public package subpath exports to include consistent `default` fallbacks for CommonJS-compatible loaders.
- Fixed `@hunvreus/heypi/authoring` resolution for discovered TypeScript agent modules loaded through CommonJS-compatible loaders.
- Fixed manual setup docs to reflect that `loadAgent()` now provides default built-in runtime tools through `builtinTools`.
- Fixed `heypi dev` printing a guessed admin URL when the HTTP listener binds to a dynamic port.
- Fixed `heypi dev` refusing to expose local test routes when the app HTTP host is not loopback.
- Fixed `heypi dev` printing duplicate admin links by showing one admin URL and using `/admin` directly when dev admin auth is disabled.
- Fixed passwordless loopback admin form posts by using a real per-instance CSRF token with same-origin checks.
- Fixed the admin header logo to use the current heypi brand assets instead of the stale inline SVG.
- Fixed approval controls being recorded as fresh user turns, which could make an approved action trigger a second approval.
- Fixed Discord approval cards keeping the pending color after approval, denial, or expiry.
- Fixed Discord approved continuations skipping the progress message while the approved action resumed.
- Fixed Discord and Telegram root channel/group conversations sharing one channel-level transcript by indexing provider message IDs and continuing explicit replies or recent same-actor follow-ups in the correct heypi thread.
- Fixed Discord control callbacks truncating run IDs that contain `:`.

## [0.2.0-beta.0] - 2026-06-15

### Breaking
- Moved approval actor identity from root `approval.approvers` and `approval.admins` to adapter-local `permissions.approvers` and `permissions.admins`. Root `approval` now only controls approval policy such as expiry, self-approval, and bypass behavior.
- Configs that still set root `approval.approvers` or `approval.admins` now fail at startup instead of silently falling back to zero-config approval authority.
- Pending approvals created by earlier unreleased builds that stored replay metadata in top-level call args should be recreated; heypi now reserves `__heypi` inside call args for internal replay metadata.

  Before:

  ```ts
  createHeypi({
    approval: {
      approvers: ["U123"],
      admins: ["U999"],
    },
    adapters: [slack({ ... })],
  });
  ```

  After:

  ```ts
  createHeypi({
    approval: {
      // expiry, self-approval, and bypass policy
    },
    adapters: [
      slack({
        ...
        permissions: {
          approvers: ["U123"],
          admins: ["U999"],
        },
      }),
    ],
  });
  ```

### Added
- Added a manual `qa/` smoke checklist for testing the Slack, Discord, Telegram, and webhook examples.
- Added approval admins with inherited approver permissions and configurable self-approval blocking.
- Added adapter-scoped approval permissions with per-adapter approvers and admins.
- Added `allow.bots` to Slack, Discord, and Telegram for explicitly accepting messages from selected bots/apps or all other bots/apps.
- Added Slack Socket Mode and HTTP mode manifest generation to `create-heypi` and `heypi slack manifest`.
- Added `heypi slack users` for Slack user ID discovery, with positional and `--query` filtering for Slack user and channel lookup.
- Added positional and `--query` filtering for `heypi discord channels`.
- Added native typed control fallback through Slack `/heypi` subcommands and Discord application commands.
- Added `task.cancel` with `admin`, `approver`, `initiator`, and `allowed` cancellation policy levels.
- Added actor-bound temporary approval bypasses through approval controls and `/revoke <bypass-id>`.
- Added durable approval bypass storage.
- Added admin configuration visibility for task behavior and adapter approval permissions.
- Added admin approval policy visibility and admin/CLI active approval bypass listing.
- Added typed chat listing for active approval bypasses.
- Added `heypi status` for persisted operator diagnostics.
- Added Telegram webhook mode with required secret-token validation, Telegram bot command registration, and `heypi telegram set-webhook`/`delete-webhook`.

### Changed
- Changed scheduled jobs to materialize durable queued `job_run` rows and execute them through scheduler worker slots instead of running every due target inline during the scheduler tick.
- Changed `heypi jobs run` to enqueue immediate job runs for current targets without mutating `job.nextAt`, preserving recurring schedule anchors.
- Changed Slack, Discord, and Telegram discovery CLI output to print provider IDs only, without example-specific config snippets.
- Changed local chat examples and generated admin apps to use `http.port: 0` by default so development servers avoid port `3000` collisions.
- Renamed example approver env vars to provider-scoped names such as `HEYPI_SLACK_APPROVERS` and `HEYPI_DISCORD_APPROVERS`.
- Added provider-scoped admin env vars to Slack and Discord examples for admin-path QA.
- Changed SQLite startup recovery for running scheduled job runs to requeue them instead of marking them failed.
- Changed `allow.bots` approval behavior so accepted bot messages do not inherit zero-config approval authority; trusted bot approvers must be explicitly listed in adapter permissions.
- Changed expired approvals to persist as `expired` instead of `denied` for clearer audit history.
- Changed typed chat control parsing to strict slash syntax such as `/approve`, `/deny`, `/approvals`, `/status`, `/cancel`, and `/bash` for adapters that deliver those messages.
- Changed chat `/approvals` listing to show only approvals actionable from the current channel; use CLI/admin for cross-channel views.
- Changed cancellation output to a single terminal task message that includes the cancelling actor when known.
- Changed same-thread busy behavior configuration from `chat.busy` to `task.busy`.
- Changed startup recovery to fail stale running calls and requeue stale running job runs after a process restart.
- Changed CLI docs to use `heypi` consistently while documenting package-manager invocation separately.
- Derived store row types from the Drizzle schema and centralized store pagination clamps.
- Centralized typed chat command metadata for help text, trigger gating, and native adapter registration.
- Split core call execution and handler turn/control helpers into narrower internal modules.

### Fixed
- Fixed invalid built-in adapter config keys like root `approvers` and `admins` being silently ignored instead of failing with a clear permissions error.
- Fixed approved custom tool replay after a restart so the original runtime scope is preserved.
- Fixed a busy-message race where a follow-up could be persisted as processed even when it failed to enqueue.
- Fixed duplicate provider retries being steered into an active run before provider-event dedupe ran.
- Fixed concurrent duplicate provider retries being steered into an active run more than once.
- Fixed adapter-scoped approval bypass matching for adapter names containing glob wildcard characters.
- Fixed shared HTTP listener startup failures being masked by cleanup `ERR_SERVER_NOT_RUNNING` errors.
- Fixed Slack attachment upload failures being logged silently after a reply claimed a file was attached.
- Fixed Slack approval continuations claiming an attachment without uploading the generated file.
- Fixed CLI `--env` path resolution under package-manager wrappers so relative paths resolve from the original command directory.
- Fixed Discord and Telegram attachment upload failures being invisible after a reply claimed a file was attached.
- Fixed streamed replies replacing the progress placeholder awkwardly by reusing the progress message as the first stream message across Slack, Discord, and Telegram.
- Fixed Telegram scheduled deliveries skipping generated file uploads.
- Fixed Telegram webhook secret-token checks to use timing-safe comparison.
- Fixed malformed approval command suffixes like `/approve <id> bypas` being silently ignored.
- Fixed approval bypass creation so actor-bound bypasses are never stored without a target actor.
- Fixed chat help to expose `/approve <id> bypass`.
- Fixed memory writes so persisted memory remains raw while prompt injection escapes memory at render time.
- Fixed memory replace/delete matching for text containing `<` or `>`.
- Fixed secret request completion so only the actor that requested the secret can submit the encrypted reply.
- Fixed Docker runtime environment propagation so configured values are passed through a private env-file path instead of direct `docker run -e KEY=value` argv.
- Fixed startup recovery silently skipping unsupported custom store recovery capabilities.
- Fixed missing debug drop logs for disallowed bot messages.
- Fixed cancellation output leaking raw `cancelled` text or duplicate success acknowledgements.
- Fixed Slack user group and Discord role resolution for approval admins.
- Fixed app shutdown so scheduled turns no longer bypass the configured drain timeout while waiting for scheduler shutdown.
- Fixed explicit `jobs: []` config so previously stored jobs are reconciled as removed instead of leaving stale active jobs behind.
- Fixed heartbeat jobs being able to overlap for the same job and stored thread while an earlier run was still queued or running.
- Fixed clean scheduler shutdown to stop claiming new work before bounded app-level drain.

### Upgrade notes
- Scheduled run rows created before `0.2.0-beta.0` do not contain the new target metadata added for durable queued job execution. If any old queued scheduled runs exist during upgrade, they may be marked failed instead of resumed.

## [0.1.3] - 2026-06-04

### Added
- Added the `create-heypi` scaffolder package for `npm create heypi@latest`, including guided adapter/runtime/model prompts, default agent folders, and safe `.env` handling.
- Added a broader curated model picker for `create-heypi` with current OpenAI, Anthropic, Google, xAI, and custom model choices.
- Added `heypi init` guidance for creating new apps.

### Changed
- Improved human CLI output with colored status labels and tables while keeping JSON and raw URL outputs machine-readable.
- Reworked the CLI reference into a command-indexed layout with per-command syntax, options, examples, and behavior notes.
- Reworked quickstart docs around `npm create heypi@latest` and split manual setup into a separate quickstart page.
- Framed Slack approval messages with a left status bar, compact metadata rows, and bottom-aligned approval buttons.

## [0.1.2] - 2026-06-04

### Changed
- Added startup security posture warnings for host runtimes, public HTTP binds, missing approvers, and chat adapters without allow filters.
- Added a timeout for webhook `replyUrl` callbacks and reserved the server-generated `whth_` thread ID prefix.
- Reworked deployment docs around the supported long-running service model, persistent storage, runtime providers, backups, and operations.
- Restored Agent configuration docs navigation to a single page instead of a nested submenu.
- Removed unsupported alternate deployment planning from TODO and architecture notes.

## [0.1.1] - 2026-06-03

### Added
- Added scoped skills with list, read, write, patch, and delete tools.
- Added encrypted secret requests with a self-hostable browser handoff page.
- Added an attach tool so agents can return generated files in chat replies.
- Added public config types for skills and secrets.
- Added Slack user group and Discord role allowlists and approval approvers.
- Added a dedicated heypi quickstart docs page.

### Changed
- Split scope, memory, skills, and secrets documentation into focused guides.
- Reworked the heypi docs navigation around getting started, concepts, adapters, features, admin, and customization.
- Reworked the heypi introduction and concepts docs around product overview, setup flow, and configuration knobs.
- Simplified adapter setup docs around app creation, required env vars, app config, event delivery, inbound access, and CLI commands.
- Merged shared chat behavior into the adapter overview.
- Collapsed tools and advanced extension documentation into one customization guide.
- Renamed package docs files to lowercase filenames.
- Moved architecture documentation out of the user docs nav into the package-level maintainer reference.
- Documented Docker and Gondolin runtime provider idle timeout behavior.
- Documented local CLI invocation with `pnpm exec`, `npm exec`, and `npx @hunvreus/heypi`.
- Updated the Discord example to use a channel-scoped Gondolin runtime with memory, skills, secrets, and attachments.
- Enabled channel-scoped memory and local secret handoff in the Slack DevOps example.
- Reworked the webhook example into a Docker-backed GitHub issue diagnosis automation with host-side GitHub read/write tools.
- Removed Slack team and Discord guild allow filters from the public adapter config.

## [0.1.0] - 2026-05-29

### Added
- Initial public release of heypi core.
- Published Docker and Gondolin runtime providers.

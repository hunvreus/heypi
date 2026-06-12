# Changelog

## [Unreleased]

## [0.1.4] - 2026-06-12

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
- Added an experimental Cloudflare deployment guide using Containers and R2 FUSE for durable runtime workspaces.
- Added approval admins with inherited approver permissions and configurable self-approval blocking.
- Added adapter-scoped approval permissions with per-adapter approvers and admins.
- Added `allow.bots` to Slack, Discord, and Telegram for explicitly accepting messages from selected bots/apps or all other bots/apps.
- Added Slack Socket Mode and HTTP mode manifest generation to `create-heypi` and `heypi slack manifest`.
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
- Changed `allow.bots` approval behavior so accepted bot messages do not inherit zero-config approval authority; trusted bot approvers must be explicitly listed in adapter permissions.
- Changed expired approvals to persist as `expired` instead of `denied` for clearer audit history.
- Changed typed chat control parsing to strict slash syntax such as `/approve`, `/deny`, `/approvals`, `/status`, `/cancel`, and `/bash` for adapters that deliver those messages.
- Changed cancellation output to a single terminal task message that includes the cancelling actor when known.
- Changed same-thread busy behavior configuration from `chat.busy` to `task.busy`.
- Changed startup recovery to fail stale running calls and job runs after a process restart.
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
- Fixed Telegram webhook secret-token checks to use timing-safe comparison.
- Fixed malformed approval command suffixes like `/approve <id> bypas` being silently ignored.
- Fixed startup recovery silently skipping unsupported custom store recovery capabilities.
- Fixed missing debug drop logs for disallowed bot messages.
- Fixed cancellation output leaking raw `cancelled` text or duplicate success acknowledgements.
- Fixed Slack user group and Discord role resolution for approval admins.

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

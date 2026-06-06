# Changelog

## [Unreleased]

### Added
- Added approval admins with inherited approver permissions and configurable self-approval blocking.

### Changed
- Changed chat control commands to strict slash syntax such as `/approve`, `/deny`, `/approvals`, `/status`, `/cancel`, and `/bash`.

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

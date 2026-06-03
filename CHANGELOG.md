# Changelog

## [Unreleased]

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

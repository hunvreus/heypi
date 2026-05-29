# Changelog

## 0.1.0-alpha.0

- Initial public alpha.
- Adds code-first chat agent apps for Slack, Discord, Telegram, and webhooks.
- Adds persisted chat threads, approvals, scheduled jobs, memory, scoped runtime workspaces, attachment handling, admin UI, and SQLite migrations.
- Adds runtime-backed core tools for shell, file, search, and chat history.
- Adds custom `tool()` definitions with optional approval gates and selected-runtime access through `ctx.runtime`.
- Adds a `RuntimeProvider` extension point for managed scoped runtimes.
- Adds experimental `@hunvreus/heypi-runtime-docker` and `@hunvreus/heypi-runtime-gondolin` provider packages.
- Keeps the root package export focused on normal app composition; advanced adapter, attachment, runtime, and store contracts live under explicit subpaths.

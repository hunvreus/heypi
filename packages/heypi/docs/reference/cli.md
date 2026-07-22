# CLI reference

The `heypi` CLI scaffolds templates and inspects chat-platform configuration without starting an
agent.

## Global behavior

Commands load `.env`, then `.env.local`; exported environment variables take precedence. Use
`--env-file path` to load another file and `--json` for machine-readable output. Output and errors
redact configured tokens, secrets, passwords, webhook secrets, and token-bearing URLs.

```text
heypi create <template> [directory] [--no-install]
heypi templates
heypi check [--json] [--env-file path]
```

`heypi create` copies a bundled example and installs dependencies with the invoking package manager.
The package-manager shorthand is `npm create heypi@latest -- codex-tag my-agent` or
`pnpm create heypi codex-tag my-agent`.

## Slack

```text
heypi slack check
heypi slack channels [--query text] [--private]
heypi slack users [--query text] [--bots]
heypi slack manifest
heypi slack env-example
```

## Discord

```text
heypi discord check
heypi discord guilds
heypi discord channels --guild id [--query text]
heypi discord invite
heypi discord env-example
```

## Telegram

```text
heypi telegram check
heypi telegram webhook-info
heypi telegram listen [--timeout seconds] --force
heypi telegram env-example
```

Inspection commands do not modify source or environment files. `telegram listen` is the exception
to passive platform access: `getUpdates` can consume messages intended for a running bot, so the
command requires `--force` and refuses to run while a webhook is configured.

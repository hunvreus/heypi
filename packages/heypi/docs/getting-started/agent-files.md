# Agent files

`loadAgent("./agent")` discovers authored resources from one folder:

```text
agent/
  instructions.md
  system.md
  skills/
  tools/
  extensions/
  schedules/
```

- `instructions.md`: stable agent behavior.
- `system.md`: optional low-level system context.
- `skills/`: procedures Pi loads when relevant, including adjacent scripts and assets.
- `tools/`: Pi extension files that register authored tools.
- `extensions/`: other Pi extensions.
- `schedules/`: trusted cron modules loaded by heypi.

Keep always-on instructions short. Put detailed procedures in skills and executable behavior in
tools or extensions.

heypi stages Pi resources under `.heypi` and excludes `.git`, `.heypi`, and `node_modules`. Agent
resources must not depend on source-tree host paths.

Pi lists staged skills by name and description, then reads matching instructions on demand. The
complete staged skill tree is available to runtime tools at managed `/agent/skills`, so relative
scripts and assets use the same model-visible path as the skill instructions. Do not modify that
tree. Docker, Gondolin, and just-bash enforce read-only access; host and remote providers use
disposable copies refreshed from staged content.

## Storage

Each adapter ID has an isolated storage area. Chat surfaces get durable workspaces, independent Pi
sessions, and audit records. `/shared` is writable across that adapter's conversations;
`/agent/skills` is staged agent content and is never synchronized back from a runtime.

heypi sends the triggering message to Pi. Older messages remain available through `chat_history`
instead of being inserted into every prompt.

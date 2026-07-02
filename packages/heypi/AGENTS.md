# heypi rewrite rules

## Direction

- Build heypi as a Pi-native chat adapter shell.
- Pi owns model execution, transcript, compaction, retries, tools, extensions, and session state.
- heypi owns agent folder loading, chat adapters, adapter auth, event mirroring, approval UI, and product configuration.
- Do not rebuild Pi mechanisms in heypi.

## Code shape

- Keep modules small and function-first.
- Prefer deleting old code over adapting it when it carries old harness assumptions.
- Do not preserve backward compatibility unless explicitly requested.
- Keep public configuration narrow and file/folder oriented:
  - `loadAgent("./agent", options)`
  - `agent/instructions.md`
  - `agent/system.md`
  - `agent/skills/`
  - `agent/tools/`
  - `agent/extensions/`
- Stage authored resources into Pi-visible locations. Do not leak host source paths into model context.

## Runtime boundary

- Send compact chat deltas to Pi sessions.
- Older chat belongs behind explicit tools, not passive prompt injection.
- Approvals, memory, and todos should be Pi extensions plus heypi renderers, not prompt machinery.
- Runtimes such as Docker or Gondolin should be provider boundaries after the core is Pi-native.

## Quality bar

- No `any`.
- Check external type definitions before assuming APIs.
- Do not add compatibility shims for deleted architecture.
- Run `./node_modules/.bin/tsc -p packages/heypi/tsconfig.build.json` after code changes.

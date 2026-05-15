# Agent Rules

## Communication
- Keep answers concise, technical, and to the point.
- Do not use filler or glazing openers (for example: "You're right to push back", "You're totally right", "Great idea").
- Keep responses MECE (mutually exclusive, collectively exhaustive).
- If only part of requested scope is implemented, state exactly what was not included.

## Naming
- Prefer short, one-word names for tables, columns, code symbols, and files when clarity is preserved.
- Use multi-word names only when needed for clarity.

## Architecture and Modules
- Keep API route handlers thin.
- Put validation, permissions, and database behavior in server-side service modules.
- Back data models with Drizzle schemas and migrations.
- Prefer function-first modules and small files over class-heavy designs.
- Keep module responsibilities narrow: orchestration in one place, side effects in clear adapters.
- Define explicit boundary contracts (typed inputs/outputs, error shape, side effects) and keep interface surfaces small and stable.

## Code Style
- Keep control flow explicit. Favor readable loops and state transitions over clever abstractions.
- Prefer simple data structures (`Map`, arrays, plain objects) and deterministic behavior.
- Use practical error handling and logs with clear failure paths.
- Prefer small, single-purpose composable helpers over large multi-responsibility utilities.
- Normalize loose/variant inputs at module edges into one canonical internal shape; keep normalization deterministic and centralized.

## TypeScript Discipline
- Use strict TypeScript at boundaries: explicit types for public APIs, typed imports, and narrow interfaces.
- Do not use `any` unless absolutely necessary. If used, keep scope narrow and document why.
- Check dependency type definitions before guessing external API shapes.
- Do not use inline/dynamic type imports. Use standard top-level imports.
- Do not remove or downgrade behavior to silence type errors from outdated dependencies; prefer upgrading/fixing the dependency path.

## Change Management
- Ask before removing functionality or code that appears intentional.
- Do not preserve backward compatibility unless explicitly requested.
- Keep user-facing input bindings/configurable controls data-driven, not hardcoded.
- After finishing a large feature or removing a feature, review changed code and direct dependencies for refactors, dead code removal, and simplifications.

## Docs and Comments
- Prefer self-explanatory code. Add comments only for non-obvious intent, invariants, edge cases, and tradeoffs.
- Do not add comments that only restate the code.
- Public modules/functions should have short doc comments describing contract: inputs, outputs, side effects, and failure conditions.
- Keep docs close to code: update relevant README/docs when behavior, config, or workflow changes.
- Keep examples/snippets aligned with current behavior when code changes.
- If scope is partial, document what was intentionally not implemented.
- Remove stale comments/docs during refactors.
- Keep technical prose concise and actionable; avoid narrative fluff.

# Quickstart

Requires Node.js 22 or later and a model provider credential supported by Pi.

## Create an agent

```sh
pnpm create heypi codex-tag my-agent
cd my-agent
cp .env.example .env
pnpm dev
```

Set `HEYPI_MODEL` in `provider/model` form and add the credentials required by that provider.

## Start manually

```ts
import { host, loadAgent, local, modelFromEnv, runHeypi } from "@hunvreus/heypi";

const agent = loadAgent("./agent", {
	model: modelFromEnv(),
	runtime: host({ workspace: "./workspace" }),
});

await runHeypi(agent, [local()]);
```

`local()` is intended for tests and embedding. Replace it with `slack()`, `discord()`,
`telegram()`, or `webhook()` for a chat service.

## Understand the generated files

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

Each adapter keeps its own state. Chat surfaces get durable workspaces, independent Pi sessions,
and audit records. `/workspace` is writable for the active chat surface, `/shared` is optional
adapter-wide shared storage, and `/agent/skills` is staged agent content. Older messages remain
available through `chat_history` instead of being inserted into every prompt.

Next, review the [configuration overview](../configuration/index.md) and choose an
[adapter](../adapters/index.md).

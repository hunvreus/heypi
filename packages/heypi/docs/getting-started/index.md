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

Next, review [agent files](agent-files.md) and the [configuration overview](../configuration/index.md).

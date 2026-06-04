<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/heypi-white.png">
    <source media="(prefers-color-scheme: light)" srcset="docs/assets/heypi-black.png">
    <img alt="heypi" src="docs/assets/heypi-black.png" width="320">
  </picture>
</p>

# heypi

AI chat agents for your team (Slack, Discord, Telegram, and webhooks).

heypi is a lightweight TypeScript framework that wraps around [Pi](https://pi.dev) to make it easy to create team chat agents: adapters, approvals, scoped runtime tools, persisted threads, memory, skills, encrypted secret handoff, generated-file attachments, scheduling, admin, and CLI diagnostics.

## Install

Requirements:

- Node.js 22 or newer.
- Optional for document conversion: Python 3 plus `uv`, or Python 3 with [Microsoft MarkItDown](https://github.com/microsoft/markitdown) already installed.

Create a new app:

```bash
npm create heypi@latest
```

For an existing TypeScript app:

```bash
npm install @hunvreus/heypi
```

## Minimal app

```ts
import { agentFrom, createHeypi, runHeypi, slack, workspace } from "@hunvreus/heypi";

const app = createHeypi({
	state: { root: "./state" },
	adapters: [
		slack({
			botToken: process.env.SLACK_BOT_TOKEN!,
			appToken: process.env.SLACK_APP_TOKEN!,
		}),
	],
	agent: agentFrom("./agent", { model: "openai/gpt-5.4-mini" }),
	runtime: { root: workspace("./workspace") },
});

await runHeypi(app);
```

`OPENAI_API_KEY` is read by Pi through its normal provider auth path. Pass `model` explicitly or set `HEYPI_MODEL`; heypi does not pick a model implicitly.

## Documentation

Start with [`docs/index.md`](docs/index.md).

- [`docs/quickstart/index.md`](docs/quickstart/index.md): first app
- [`docs/configuration/index.md`](docs/configuration/index.md): app-level configuration map
- [`docs/configuration/agent.md`](docs/configuration/agent.md): prompts, model config, and dynamic context
- [`docs/configuration/tools.md`](docs/configuration/tools.md): core tools, custom tools, confirmation, managed tools, and trusted code
- [`docs/adapters/index.md`](docs/adapters/index.md): Slack, Discord, Telegram, and webhook adapters
- [`docs/configuration/runtime.md`](docs/configuration/runtime.md): runtime backends and lifecycle
- [`docs/configuration/scope.md`](docs/configuration/scope.md): scope model and filesystem layout
- [`docs/configuration/memory.md`](docs/configuration/memory.md), [`docs/configuration/skills.md`](docs/configuration/skills.md), [`docs/configuration/secrets.md`](docs/configuration/secrets.md): persistent context and secret handoff
- [`docs/configuration/scheduling.md`](docs/configuration/scheduling.md), [`docs/configuration/admin.md`](docs/configuration/admin.md), [`docs/reference/cli.md`](docs/reference/cli.md): scheduling, admin, and CLI
- [`docs/guides/integrations.md`](docs/guides/integrations.md): custom adapters, stores, attachment stores, runtime providers, and Pi extensions
- [`docs/guides/deployment.md`](docs/guides/deployment.md): production deployment
- [`ARCHITECTURE.md`](ARCHITECTURE.md): maintainer internals

## Runtime

`just-bash` is built in and is the default runtime. Optional provider packages add stronger isolation:

- [`@hunvreus/heypi-runtime-docker`](https://www.npmjs.com/package/@hunvreus/heypi-runtime-docker): Docker provider.
- [`@hunvreus/heypi-runtime-gondolin`](https://www.npmjs.com/package/@hunvreus/heypi-runtime-gondolin): Gondolin VM provider.

Both provider packages implement heypi's runtime API, so core bash, file, and search tools run through the selected sandbox.

## Examples

- [`examples/slack-devops`](https://github.com/hunvreus/heypi/tree/main/examples/slack-devops): Slack DevOps assistant with runtime tools, runbooks, memory, secrets, SSH host inventory, and approvals.
- [`examples/discord-gondolin`](https://github.com/hunvreus/heypi/tree/main/examples/discord-gondolin): Discord assistant with a channel-scoped Gondolin VM, memory, skills, secret requests, and generated-file attachments.
- [`examples/telegram-workout`](https://github.com/hunvreus/heypi/tree/main/examples/telegram-workout): Telegram fitness coach with saved profile/plan and heartbeat check-ins.
- [`examples/webhook-github-docker`](https://github.com/hunvreus/heypi/tree/main/examples/webhook-github-docker): GitHub issue automation with webhook input, Docker repo inspection, and trusted GitHub writeback.

## License

[MIT](LICENSE)

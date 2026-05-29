# @hunvreus/heypi-runtime-docker

**Experimental:** this provider is intended for local testing and early adopters. Its API and operational behavior may change before heypi 1.0.

Docker runtime provider for heypi. It runs heypi's runtime API through a scoped Docker container: `bash`, `read`, `write`, `edit`, `grep`, `find`, and `ls`.

## Requirements

- Node.js 22 or newer.
- `@hunvreus/heypi` installed in the same app. This package declares it as a peer dependency.
- Docker CLI on `PATH`.
- Docker daemon running and accessible to the app process.
- A Linux image that includes `bash` for the `bash` tool.
- The image also needs standard POSIX utilities for file/search tools: `sh`, `find`, `awk`, `wc`, `sed`, `cat`, and `head`.

## Quickstart

```bash
npm install @hunvreus/heypi @hunvreus/heypi-runtime-docker
docker version
docker pull debian:bookworm-slim
```

```ts
import { agentFrom, createHeypi, runHeypi, slack, workspace } from "@hunvreus/heypi";
import { dockerRuntime } from "@hunvreus/heypi-runtime-docker";

const app = createHeypi({
	state: { root: "./state" },
	adapters: [
		slack({
			botToken: process.env.SLACK_BOT_TOKEN!,
			appToken: process.env.SLACK_APP_TOKEN!,
		}),
	],
	agent: agentFrom("./agent", { model: "openai/gpt-5-mini" }),
	runtime: {
		root: workspace("./workspace"),
		scope: "channel",
		provider: dockerRuntime({
			image: "debian:bookworm-slim",
			network: "none",
			idleMs: 10 * 60 * 1000,
		}),
	},
});

await runHeypi(app);
```

## Behavior

- One warm container is kept per heypi runtime scope.
- The scoped runtime root is bind-mounted at `/workspace`.
- Commands run with `docker exec` inside the container.
- File/search tools run shell scripts inside the container. They do not read or write through host filesystem shortcuts.
- Containers stop after `idleMs` with no use. Set `idleMs: false` to keep them until app shutdown.
- `network` defaults to `"none"`. Set `network: "bridge"` or another Docker network only when the agent needs network access.
- The provider checks that the scoped container is still running before reuse and recreates it if Docker reports it stopped.
- Containers are labeled with `heypi.runtime=docker`, `heypi.prefix`, and scope metadata for local inspection and cleanup.
- Runtime lifecycle events are logged through the heypi app logger when the provider is used inside `createHeypi()`.
- Cold starts emit a runtime progress event. heypi renders it with the global `messages.runtimeStarting` copy, which defaults to `Preparing runtime...` and can be set to `false`.

## Options

```ts
dockerRuntime({
	image: "debian:bookworm-slim",
	network: "none",
	idleMs: 10 * 60 * 1000,
	timeoutMs: 120_000,
	env: { NODE_ENV: "production" },
	labels: { "com.example.app": "ops-agent" },
	user: "1000:1000",
	extraRunArgs: ["--cpus", "1"],
	limits: {
		maxFileBytes: 1_000_000,
		maxScanBytes: 5_000_000,
		maxEntries: 10_000,
	},
});
```

The returned provider also exposes management hooks:

```ts
const provider = dockerRuntime({ image: "debian:bookworm-slim" });
const [status] = (await provider.status?.()) ?? [];

if (status) await provider.restart?.(status.scope);
if (status) await provider.stop?.(status.scope);
await provider.cleanup?.();
```

Docker itself is trusted host infrastructure. Anyone who can control the Docker daemon can control the host.

# heypi Docker runtime

Docker runtime provider for [`@hunvreus/heypi`](https://www.npmjs.com/package/@hunvreus/heypi). It runs heypi's runtime API through one warm Docker container per runtime scope: `bash`, `read`, `write`, `edit`, `grep`, `find`, and `ls`.

## Requirements

- Node.js 22 or newer.
- `@hunvreus/heypi` installed in the same app.
- Docker CLI on `PATH`.
- Docker daemon running and accessible to the app process.
- A Linux image with `bash`.
- Standard POSIX utilities in the image for file/search tools: `sh`, `find`, `awk`, `wc`, `sed`, `cat`, and `head`.

## Quickstart

```bash
npm install @hunvreus/heypi @hunvreus/heypi-runtime-docker
docker version
docker pull debian:bookworm-slim
```

```ts
import { createHeypi, workspace } from "@hunvreus/heypi";
import { dockerRuntime } from "@hunvreus/heypi-runtime-docker";

createHeypi({
	// ...state, adapters, agent
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
```

Use `network: "bridge"` only when the agent needs network access.

## Behavior

- The scoped runtime root is bind-mounted at `/workspace`.
- Commands run with `docker exec` inside the container.
- File/search tools execute inside the container, not through host filesystem shortcuts.
- Containers stop after `idleMs` with no use. Set `idleMs: false` to keep them until app shutdown.
- The provider checks that a cached scoped container is still running before reuse and recreates it if needed.
- Containers are labeled with `heypi.runtime=docker`, `heypi.prefix`, and scope metadata for local inspection and cleanup.
- Cold starts emit a runtime progress event. heypi renders it with `messages.runtimeStarting`, which defaults to `Preparing runtime...`.

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

The provider exposes optional management hooks:

```ts
const provider = dockerRuntime();
const [status] = (await provider.status?.()) ?? [];

if (status) await provider.restart?.(status.scope);
if (status) await provider.stop?.(status.scope);
await provider.cleanup?.();
```

Docker itself is trusted host infrastructure. Anyone who can control the Docker daemon can control the host.

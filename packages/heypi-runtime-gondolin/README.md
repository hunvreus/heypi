# heypi Gondolin runtime

Gondolin runtime provider for [`@hunvreus/heypi`](https://www.npmjs.com/package/@hunvreus/heypi). It runs heypi's runtime API through one warm Gondolin VM per runtime scope: `bash`, `read`, `write`, `edit`, `grep`, `find`, and `ls`.

## Requirements

- Node.js 23.6 or newer. This follows `@earendil-works/gondolin`'s runtime requirement.
- `@hunvreus/heypi` installed in the same app.
- QEMU installed for Gondolin's default VM backend.
  - macOS: `brew install qemu`
  - Debian/Ubuntu: `sudo apt install qemu-system-arm`
- Internet access on first run so Gondolin can download and cache its guest image.

No separate daemon, auth token, or hosted service is required by this provider.

## Quickstart

```bash
npm install @hunvreus/heypi @hunvreus/heypi-runtime-gondolin
qemu-system-aarch64 --version
```

```ts
import { createHeypi, workspace } from "@hunvreus/heypi";
import { gondolinRuntime } from "@hunvreus/heypi-runtime-gondolin";

createHeypi({
	// ...state, adapters, agent
	runtime: {
		root: workspace("./workspace"),
		scope: "channel",
		provider: gondolinRuntime({
			idleMs: 10 * 60 * 1000,
		}),
	},
});
```

## Behavior

- The scoped runtime root is mounted at `/workspace`.
- Bash and file/search tools execute through the VM, not host filesystem shortcuts.
- VMs stop after `idleMs` with no use. Set `idleMs: false` to keep them until app shutdown.
- VM egress is open by default.
- Extra host directories can be mounted with `mounts`.
- Secrets can be passed with `secrets`; Gondolin exposes them through HTTP hooks instead of giving the agent raw secret values.
- Timed out, cancelled, or crashed VM executions close the VM so the next runtime call starts a fresh one.
- Cold starts emit a runtime progress event. heypi renders it with `messages.runtimeStarting`, which defaults to `Preparing runtime...`.

## Options

```ts
gondolinRuntime({
	idleMs: 10 * 60 * 1000,
	timeoutMs: 120_000,
	env: { NODE_ENV: "production" },
	mounts: {
		"/shared": "./shared",
	},
	secrets: {
		EXAMPLE_API_KEY: {
			value: process.env.EXAMPLE_API_KEY!,
			hosts: ["api.example.com"],
		},
	},
	limits: {
		maxFileBytes: 1_000_000,
		maxScanBytes: 5_000_000,
		maxEntries: 10_000,
	},
});
```

The provider exposes optional management hooks:

```ts
const provider = gondolinRuntime();
const [status] = (await provider.status?.()) ?? [];

if (status) await provider.restart?.(status.scope);
if (status) await provider.stop?.(status.scope);
await provider.cleanup?.();
```

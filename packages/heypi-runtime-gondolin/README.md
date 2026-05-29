# @hunvreus/heypi-runtime-gondolin

**Experimental:** this provider is intended for local testing and early adopters. Its API and operational behavior may change before heypi 1.0.

Gondolin runtime provider for heypi. It runs heypi's runtime API through a scoped Gondolin VM: `bash`, `read`, `write`, `edit`, `grep`, `find`, and `ls`.

## Requirements

- Node.js 23.6 or newer. This follows `@earendil-works/gondolin`'s runtime requirement.
- `@hunvreus/heypi` installed in the same app. This package declares it as a peer dependency.
- QEMU installed for Gondolin's default VM backend.
  - macOS: `brew install qemu`
  - Debian/Ubuntu: `sudo apt install qemu-system-arm`
- Internet access on first run so Gondolin can download and cache its guest image.
- No separate daemon, auth token, or hosted service is required by this provider.

`@earendil-works/gondolin` is installed as a package dependency. The default Alpine guest image includes the shell utilities used by heypi runtime tools.

## Quickstart

```bash
npm install @hunvreus/heypi @hunvreus/heypi-runtime-gondolin
qemu-system-aarch64 --version
```

```ts
import { agentFrom, createHeypi, runHeypi, slack, workspace } from "@hunvreus/heypi";
import { gondolinRuntime } from "@hunvreus/heypi-runtime-gondolin";

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
		provider: gondolinRuntime({
			idleMs: 10 * 60 * 1000,
		}),
	},
});

await runHeypi(app);
```

## Behavior

- One warm Gondolin VM is kept per heypi runtime scope.
- The scoped runtime root is mounted at `/workspace`.
- Bash and file/search tools execute through the VM. They do not read or write through host filesystem shortcuts.
- VMs stop after `idleMs` with no use. Set `idleMs: false` to keep them until app shutdown.
- Extra host directories can be mounted with `mounts`.
- VM egress is open by default. Use Gondolin secrets with per-host `hosts` restrictions for sensitive outbound credentials.
- Secrets can be passed with `secrets`; Gondolin exposes them through HTTP hooks instead of giving the agent raw secret values.
- Runtime lifecycle events are logged through the heypi app logger when the provider is used inside `createHeypi()`.
- Cold starts emit a runtime progress event. heypi renders it with the global `messages.runtimeStarting` copy, which defaults to `Preparing runtime...` and can be set to `false`.
- Timed out, cancelled, or crashed VM executions close the VM so the next runtime call starts a fresh one.

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

The returned provider also exposes management hooks:

```ts
const provider = gondolinRuntime();
const [status] = (await provider.status?.()) ?? [];

if (status) await provider.restart?.(status.scope);
if (status) await provider.stop?.(status.scope);
await provider.cleanup?.();
```

# HeyPi Cloudflare Sandbox runtime

Adapts a caller-owned Cloudflare Sandbox SDK `ISandbox`. The provider creates one explicit execution
session, synchronizes durable roots, and deletes only that session during cleanup.

```sh
npm install @hunvreus/heypi-runtime-cloudflare
```

```ts
import { getSandbox } from "@cloudflare/sandbox";
import { cloudflare } from "@hunvreus/heypi-runtime-cloudflare";

const runtime = cloudflare({
	workspace: "./workspace",
	sandbox: getSandbox(env.Sandbox, "agent", {
		transport: "rpc",
		enableDefaultSession: false,
	}),
});
```

The caller owns the Durable Object sandbox lifecycle and must export/configure the Cloudflare Sandbox
binding. The mirror refreshes before each turn, preserves modes and root-confined symlinks,
propagates remote deletions, and leaves unrelated host files intact. Runtime `env` values are
model-visible and are not secret brokering.
Commands run with `/bin/bash -lc`; the Cloudflare sandbox image must include Bash.

See the [runtime documentation](https://heypi.dev/docs/configuration/runtimes/).

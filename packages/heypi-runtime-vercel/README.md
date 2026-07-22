# HeyPi Vercel Sandbox runtime

Runs HeyPi's Pi core tools in a Vercel Sandbox. The provider uploads the durable host roots at startup,
mirrors direct file-tool writes, downloads files after bash commands, and stops the sandbox on cleanup.

```sh
npm install @hunvreus/heypi-runtime-vercel
```

```ts
import { loadAgent } from "@hunvreus/heypi";
import { vercel } from "@hunvreus/heypi-runtime-vercel";

const agent = loadAgent("./agent", {
	runtime: vercel({
		workspace: "./workspace",
		sandbox: { runtime: "node24", timeout: 10 * 60_000 },
	}),
});
```

Authentication follows the Vercel SDK (`VERCEL_OIDC_TOKEN` or explicit Vercel credentials). The
mirror refreshes before each turn, preserves modes and root-confined symlinks, propagates remote
deletions, and leaves unrelated host files intact. Runtime `env` values are model-visible and are not
secret brokering.
Commands run with `/bin/bash -lc`; the selected Vercel runtime must include Bash.

See the [runtime documentation](https://heypi.dev/docs/configuration/runtimes/).

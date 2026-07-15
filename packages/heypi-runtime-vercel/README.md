# HeyPi Vercel Sandbox runtime

Runs HeyPi's Pi core tools in a Vercel Sandbox. The provider uploads the durable host roots at startup,
mirrors direct file-tool writes, downloads files after bash commands, and stops the sandbox on cleanup.

```ts
import { vercel } from "@hunvreus/heypi-runtime-vercel";

const agent = loadAgent("./agent", {
	runtime: vercel({
		workspace: "./workspace",
		sandbox: { runtime: "node24", timeout: 10 * 60_000 },
	}),
});
```

Authentication follows the Vercel SDK (`VERCEL_OIDC_TOKEN` or explicit Vercel credentials). Remote
deletions are not propagated to the host. Runtime `env` values are model-visible and are not secret
brokering.

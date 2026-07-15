# HeyPi just-bash runtime

Runs HeyPi's Pi core tools through the `just-bash` interpreter. `/workspace` and optional `/shared`
paths map to durable host directories through `ReadWriteFs`; commands cannot use the host shell.

```ts
import { justBash } from "@hunvreus/heypi-runtime-just-bash";

const agent = loadAgent("./agent", {
	runtime: justBash({ workspace: "./workspace" }),
});
```

Network, Python, and JavaScript execution follow `just-bash` options and are disabled unless enabled
explicitly. Runtime `env` values are model-visible and must not contain secrets.

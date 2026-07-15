# HeyPi Gondolin runtime

Runs HeyPi's Pi core tools in a Gondolin QEMU micro-VM. The durable host workspace and shared root are
bind-mounted at `/workspace` and `/shared`.

```ts
import { gondolin } from "@hunvreus/heypi-runtime-gondolin";

const agent = loadAgent("./agent", {
	runtime: gondolin({ workspace: "./workspace", memory: "2G" }),
});
```

Requires Node 23.6+ and QEMU. Runtime `env` values are model-visible and must not contain secrets.

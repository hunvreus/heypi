# HeyPi Gondolin runtime

Runs HeyPi's Pi core tools in a Gondolin QEMU micro-VM. The durable host workspace and shared root are
bind-mounted at `/workspace` and `/shared`.

```sh
npm install @hunvreus/heypi-runtime-gondolin
```

```ts
import { loadAgent } from "@hunvreus/heypi";
import { gondolin } from "@hunvreus/heypi-runtime-gondolin";

const agent = loadAgent("./agent", {
	runtime: gondolin({ workspace: "./workspace", memory: "2G" }),
});
```

Requires Node 23.6+ and QEMU. Runtime `env` values are model-visible and must not contain secrets.
Commands use `/bin/bash -lc` by default. Gondolin's default root filesystem includes Bash; custom
images must include it or set `shell` to another Bash-compatible executable.

See the [runtime documentation](https://heypi.dev/docs/configuration/runtimes/).

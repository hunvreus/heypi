# Runtimes

A runtime owns Pi's `read`, `write`, `edit`, `find`, `grep`, `ls`, and `bash` tools. A provider must
implement the full contract; failed or unsupported operations never fall back to the host.

## Choose a runtime

| Runtime | Isolation | Persistence | Package |
| --- | --- | --- | --- |
| Host | None beyond file-tool path checks | Direct host workspace | `@hunvreus/heypi` |
| Docker | Container | Bind-mounted workspace | `@hunvreus/heypi` |
| just-bash | In-process interpreter and confined filesystem | Mounted host roots | `@hunvreus/heypi-runtime-just-bash` |
| Gondolin | Local QEMU micro-VM | Bind-mounted host roots | `@hunvreus/heypi-runtime-gondolin` |
| Vercel | Managed remote sandbox | Mirrored host roots | `@hunvreus/heypi-runtime-vercel` |
| Cloudflare | Caller-owned Sandbox SDK instance | Mirrored host roots | `@hunvreus/heypi-runtime-cloudflare` |

## Host and Docker

```ts
runtime: host({ workspace: "./workspace" })
```

Host file tools remain inside the workspace, but Bash can leave it. Use host execution only when
model-directed commands are trusted. Unix requires `/bin/bash`; Windows uses Pi's Git Bash discovery.

```ts
runtime: docker({
	workspace: "./workspace",
	image: "node:22-bookworm",
})
```

Docker bind-mounts the workspace at `/workspace` and executes `/bin/bash -lc`. Docker does not supply
a shell; the selected image must include Bash. The default image does.

## Additional providers

```ts
import { gondolin } from "@hunvreus/heypi-runtime-gondolin";

runtime: gondolin({ workspace: "./workspace" })
```

Gondolin requires Node.js 23.6 or later and QEMU. Vercel and Cloudflare mirror files before turns and
after commands so generated files remain available to attachments. Cloudflare requires a
caller-owned `ISandbox`; Vercel follows the Vercel SDK authentication model.

## Environment variables

Runtime `env` values are visible to model-driven commands and are not secret-safe:

```ts
runtime: host({ workspace: "./workspace", env: { CI: "1" } })
```

Use trusted tools, provider credential brokers, or [secret requests](secrets.md) for credentials.
See [Create a custom runtime](../guides/custom-runtimes.md) for the provider contract.

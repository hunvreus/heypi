# Runtime

Runtime config controls where bash commands, file operations, and code execution run.

## Config

```ts
createHeypi({
  runtime: {
    root: workspace("./workspace"),
    name: "just-bash",
  },
  // ...state, adapters, agent
});
```

## Options

| Option | Required | Default | Description |
| --- | --- | --- | --- |
| `root` | Yes | - | Runtime workspace root. |
| `name` | No | `"just-bash"` | Built-in runtime name. Ignored when `provider` is set. |
| `provider` | No | None | Custom runtime provider. See [Custom integrations](../guides/integrations.md). |
| `scope` | No | Top-level [`scope`](scope.md) | Runtime workspace sharing boundary. |
| `timeoutMs` | No | Runtime default | Per-command timeout. |
| `maxConcurrent` | No | `12` | Global runtime call concurrency. |
| `maxConcurrentPerChat` | No | `1` | Per-chat runtime call concurrency. |
| `limits` | No | Built-in defaults | File size, line count, and search result limits. |
| `justBash` | No | Built-in defaults | just-bash filesystem, commands, JS/Python, and network config. |
| `hostEnv` | No | Minimal env | Extra environment for host-based runtimes. |

## Runtime types

- `just-bash`: default runtime. Runs a TypeScript bash interpreter with a virtual filesystem. JavaScript and Python execution can be enabled through just-bash config. Network access is disabled by default.
- `host-bash`: runs bash on the host filesystem as the heypi process user. Use only for trusted local or administrative apps.
- `guarded-bash`: host bash with heypi command classification. The policy is governance, not isolation; use only for trusted local or administrative apps.
- Docker provider: one warm Docker container per runtime scope. Install [`@hunvreus/heypi-runtime-docker`](https://www.npmjs.com/package/@hunvreus/heypi-runtime-docker).
- Gondolin provider: one warm Gondolin VM per runtime scope. Install [`@hunvreus/heypi-runtime-gondolin`](https://www.npmjs.com/package/@hunvreus/heypi-runtime-gondolin).

Docker and Gondolin implement bash, file, search, and generated-file operations inside the sandbox.

## Scope and lifecycle

Runtime providers receive a `RuntimeScope`, including a scoped filesystem path. They can keep a container, VM, or remote workspace warm per scope.

- `just-bash`: in-process, immediate, and has no warm-up step.
- Docker and Gondolin: lazy-start one runtime per scope, then keep it warm with a 10-minute idle timeout by default.
- Set `idleMs: false` on the provider config to keep scoped runtimes alive until the app stops or the provider is explicitly cleaned up.

## Network defaults

- `just-bash`: no network unless configured with allowed URL prefixes or full internet access.
- Docker: no network unless configured with a Docker network such as `bridge`.
- Gondolin: VM egress is open by default.

Configure only the network access the agent needs.

heypi logs a startup warning for `host-bash` and `guarded-bash`. For shared or team-facing bots, prefer `just-bash`, Docker, or Gondolin.

## Custom providers

Custom runtime providers implement `RuntimeProvider` from `@hunvreus/heypi/runtime`. See [Custom integrations](../guides/integrations.md).

Use a provider when you want default tools and `ctx.runtime` calls to share the same backend: Docker, Gondolin, Daytona, E2B, a remote VM manager, or an internal execution service.

Keep provider-specific features outside the common runtime API unless heypi needs them for common tool behavior. For example, preview URLs, package caches, image templates, and port forwarding can remain provider-specific.

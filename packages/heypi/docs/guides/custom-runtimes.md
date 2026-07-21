# Create a custom runtime

A runtime owns every Pi core file and command tool. It must never fall back to host execution when a
backend cannot implement an operation.

```ts
import {
	createRuntimeToolDefinitions,
	type RuntimeConfig,
	type RuntimeProvider,
} from "@hunvreus/heypi/runtime";

const provider: RuntimeProvider = async (context) => {
	const sandbox = await connect(context);
	return {
		tools: createRuntimeToolDefinitions({
			roots: context,
			fs: sandbox.fs,
			bash: sandbox.bash,
		}),
		prepare: () => sandbox.refresh(),
		cleanup: () => sandbox.close(),
	};
};

export function remote(workspace: string): RuntimeConfig {
	return { workspace, provider };
}
```

The guest roots are writable `/workspace`, optional writable `/shared`, and managed
`/agent/skills`. `context.skills` is the trusted staged host source for that skill tree. A provider
must mount it read-only or upload a disposable copy before a turn, preserve file modes, reject
escaping symlinks, and never synchronize runtime changes back to the host source.
`createRuntimeMirror()` implements those copy semantics for remote filesystems.

Confine every path to declared roots, forward abort signals and command output, and release
resources in `cleanup()`. Use `prepare()` to refresh a reused remote sandbox before each turn.

Runtime `env` is visible to model-driven code and is not secret-safe. Add credentials only when that
exposure is acceptable or implement a backend credential broker.

The Gondolin, just-bash, Vercel, and Cloudflare runtime packages are concrete provider examples.

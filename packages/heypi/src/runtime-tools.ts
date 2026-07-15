import { createDockerRuntimeTools } from "./runtime-docker.js";
import { createHostRuntimeTools } from "./runtime-host.js";
import type { RuntimeRoots } from "./runtime-path.js";
import type { RuntimeConfig, RuntimeInstance } from "./types.js";

export type RuntimeTools = RuntimeInstance;

/**
 * Builds Pi tool definitions for the configured runtime.
 *
 * Host file tools are workspace-constrained. Host bash is not a hard sandbox:
 * use Docker or another sandbox runtime for untrusted command execution.
 */
export async function createRuntimeTools(
	runtime: RuntimeConfig | undefined,
	workspace: string,
	shared?: string,
): Promise<RuntimeTools> {
	const kind = runtime?.kind ?? "host";
	const roots: RuntimeRoots = shared ? { workspace, shared } : { workspace };
	if (runtime?.provider) return runtime.provider({ ...roots, env: runtime.env });
	if (kind === "host") {
		return { tools: createHostRuntimeTools(roots, runtime?.env), async cleanup() {} };
	}
	if (runtime?.kind === "docker") {
		return createDockerRuntimeTools(runtime, roots);
	}
	throw new Error(`Unsupported runtime: ${kind}`);
}

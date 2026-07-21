import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
	skills?: string,
): Promise<RuntimeTools> {
	const kind = runtime?.kind ?? "host";
	const roots: RuntimeRoots = { workspace, ...(shared ? { shared } : {}), ...(skills ? { skills } : {}) };
	if (runtime?.provider) return runtime.provider({ ...roots, env: runtime.env });
	if (kind === "host") {
		if (!skills) return { tools: createHostRuntimeTools(roots, runtime?.env), async cleanup() {} };
		const temporary = await mkdtemp(join(tmpdir(), "heypi-skills-"));
		const runtimeSkills = join(temporary, "skills");
		const hostRoots = { ...roots, skills: runtimeSkills };
		const prepare = async () => {
			await rm(runtimeSkills, { recursive: true, force: true });
			await cp(skills, runtimeSkills, { recursive: true, force: true });
		};
		try {
			await prepare();
			return {
				tools: createHostRuntimeTools(hostRoots, runtime?.env),
				prepare,
				cleanup: () => rm(temporary, { recursive: true, force: true }),
			};
		} catch (error) {
			await rm(temporary, { recursive: true, force: true });
			throw error;
		}
	}
	if (runtime?.kind === "docker") {
		return createDockerRuntimeTools(runtime, roots);
	}
	throw new Error(`Unsupported runtime: ${kind}`);
}

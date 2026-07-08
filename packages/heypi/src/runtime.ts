import type { RuntimeConfig } from "./types.js";

export type HostRuntimeOptions = {
	workspace?: string;
	env?: Record<string, string>;
};

/**
 * Uses the host process workspace for Pi file and command operations.
 */
export function host(options: HostRuntimeOptions = {}): RuntimeConfig {
	return { kind: "host", workspace: options.workspace, env: options.env };
}

export type DockerRuntimeOptions = {
	workspace?: string;
	image?: string;
	env?: Record<string, string>;
};

/**
 * Declares a Docker-backed runtime.
 *
 * Pi core file tools and bash run inside a managed Docker container with the
 * workspace bind-mounted at `/workspace`.
 */
export function docker(options: DockerRuntimeOptions = {}): RuntimeConfig & { image?: string } {
	return { kind: "docker", workspace: options.workspace, image: options.image, env: options.env };
}

import { Container } from "@cloudflare/containers";

export type PiRunnerEnv = {
	HEYPI_MODEL?: string;
	ANTHROPIC_API_KEY?: string;
	OPENAI_API_KEY?: string;
};

/**
 * The Pi runner as a Cloudflare Container. The container image runs the runner HTTP service
 * (src/container/runner-server.ts) on `defaultPort`; the model + provider key are injected from the
 * Worker's bindings/secrets via envVars. The ThreadAgent DO reaches it through the PI_RUNNER
 * binding (see ContainerBindingRunner), so the whole stack — ingress, state, and agent — runs on
 * Cloudflare with no external host.
 */
export class PiRunner extends Container<PiRunnerEnv> {
	defaultPort = 8788;
	sleepAfter = "15m";
	envVars = {
		RUNNER_PORT: "8788",
		AGENT_DIR: "/app/packages/heypi-cloudflare/agent",
		RUNNER_STATE: "/app/.runner-state",
		HEYPI_MODEL: this.env.HEYPI_MODEL ?? "anthropic/claude-sonnet-4-6",
		ANTHROPIC_API_KEY: this.env.ANTHROPIC_API_KEY ?? "",
		OPENAI_API_KEY: this.env.OPENAI_API_KEY ?? "",
	};
}

import { resolve } from "node:path";
import { createHeypi, defaultTools, loadAgent, webhook, workspace } from "@hunvreus/heypi";
import { dockerRuntime } from "@hunvreus/heypi-runtime-docker";

const adapters = [
	webhook({
		name: "github",
	}),
];

const app = createHeypi({
	state: { root: "./state" },
	http: {
		host: "127.0.0.1",
		port: Number(process.env.HEYPI_WEBHOOK_PORT ?? 3000),
	},
	scope: "channel",
	adapters,
	agent: loadAgent("./agent", {
		model: "openai/gpt-5.4-mini",
		builtinTools: defaultTools({
			bash: true,
			write: false,
			edit: false,
			attach: false,
		}),
	}),
	runtime: {
		root: workspace("./workspace"),
		scope: "channel",
		provider: dockerRuntime({
			image: "node:22-bookworm",
			network: "bridge",
			env: {
				NPM_CONFIG_CACHE: "/cache/npm",
				npm_config_store_dir: "/cache/pnpm",
			},
			extraRunArgs: [
				"-v",
				`${resolve("./workspace/cache/npm")}:/cache/npm:rw`,
				"-v",
				`${resolve("./workspace/cache/pnpm")}:/cache/pnpm:rw`,
			],
			idleMs: 10 * 60 * 1000,
		}),
	},
});

export default app;

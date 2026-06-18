import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { loadEnvFile } from "node:process";
import { pathToFileURL } from "node:url";
import { createHeypi, defaultTools, loadAgent, local, runHeypi, webhook, workspace } from "@hunvreus/heypi";
import { dockerRuntime } from "@hunvreus/heypi-runtime-docker";

loadEnv(".env");

const isDev = process.env.HEYPI_DEV === "1";

function loadEnv(path: string): void {
	if (existsSync(path)) loadEnvFile(path);
}

function required(name: string): string {
	const value = process.env[name];
	if (!value) throw new Error(`Missing env var: ${name}`);
	return value;
}

const adapters = isDev
	? [local()]
	: [
			webhook({
				name: "github",
				secret: required("HEYPI_WEBHOOK_SECRET"),
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
		model: "openai/gpt-5-mini",
		tools: defaultTools({
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

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
	await runHeypi(app);
}

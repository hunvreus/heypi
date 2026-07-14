import { approval, type Adapter, createHeypi, docker, host, loadAgent, local, modelFromEnv, slack } from "@hunvreus/heypi";

function env(name: string): string | undefined {
	return process.env[name]?.trim() || undefined;
}

function runtime() {
	const workspace = env("HEYPI_WORKSPACE") ?? process.cwd();
	const token = env("GITHUB_TOKEN");
	const runtimeEnv = token ? { GITHUB_TOKEN: token } : undefined;
	if (env("HEYPI_RUNTIME") === "host") return host({ workspace, env: runtimeEnv });
	return docker({
		workspace,
		image: env("HEYPI_DOCKER_IMAGE") ?? "heypi-codex-tag:local",
		env: runtimeEnv,
	});
}

const agent = loadAgent(new URL("./agent", import.meta.url).pathname, {
	id: "codex-tag",
	model: modelFromEnv(),
	tools: {
		bash: {
			approve: approval.command(),
		},
	},
	runtime: runtime(),
	state: {
		dir: env("HEYPI_STATE") ?? new URL("./.heypi", import.meta.url).pathname,
	},
	admin: { port: Number(env("HEYPI_ADMIN_PORT") ?? 4321), token: env("HEYPI_ADMIN_TOKEN") },
});

const adapters: Adapter[] = [local("codex-tag-local")];
const slackToken = env("SLACK_BOT_TOKEN");
const slackAppToken = env("SLACK_APP_TOKEN");
if (slackToken && slackAppToken) {
	adapters.push(
			slack({
				token: slackToken,
				appToken: slackAppToken,
				busy: "queue",
				approvals: { layout: "message" },
		}),
	);
}

const app = await createHeypi({
	agent,
	adapters,
});
await app.start();

process.once("SIGINT", async () => {
	await app.stop();
	process.exit(0);
});

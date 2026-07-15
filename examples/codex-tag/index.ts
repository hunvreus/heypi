import { type Adapter, approval, docker, loadAgent, local, modelFromEnv, runHeypi, slack } from "@hunvreus/heypi";

function env(name: string): string | undefined {
	return process.env[name]?.trim() || undefined;
}

const githubToken = env("GITHUB_TOKEN");

const agent = loadAgent("./agent", {
	id: "codex-tag",
	model: modelFromEnv(),
	runtime: docker({
		image: "heypi-codex-tag:local",
		env: githubToken ? { GITHUB_TOKEN: githubToken } : undefined,
	}),
	tools: {
		bash: {
			approve: approval.command(),
		},
	},
	admin: {},
});

const adapters: Adapter[] = [local()];
const slackToken = env("SLACK_BOT_TOKEN");
const slackAppToken = env("SLACK_APP_TOKEN");
if (slackToken && slackAppToken) {
	adapters.push(
		slack({
			token: slackToken,
			appToken: slackAppToken,
		}),
	);
}

await runHeypi(agent, adapters);

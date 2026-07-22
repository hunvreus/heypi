# Configuration

Configuration lives in TypeScript. heypi does not split settings between a JSON manifest and an
entrypoint.

```ts
import { approval, docker, loadAgent, modelFromEnv, runHeypi, slack } from "@hunvreus/heypi";

const agent = loadAgent("./agent", {
	id: "support",
	model: modelFromEnv(),
	runtime: docker({ workspace: "./workspace", image: "node:22-bookworm" }),
	state: { dir: ".heypi" },
	admin: {},
	tools: {
		bash: { approve: approval.command() },
		write: false,
	},
});

await runHeypi(agent, [
	slack({
		id: "company-slack",
		token: process.env.SLACK_BOT_TOKEN!,
		appToken: process.env.SLACK_APP_TOKEN!,
		allow: { channels: ["C0123456789"] },
		busy: "queue",
	}),
]);
```

## Topics

- [Agent](agent.md): model, state, feature toggles, and agent resources.
- [Runtimes](runtimes.md): host, Docker, Gondolin, just-bash, Vercel, and Cloudflare execution.
- [Tools](tools.md): built-in tools, authored tools, and tool overrides.
- [Approvals](approvals.md): policies, approvers, layouts, and failure behavior.
- [Access](access.md): DM, channel, user, group, and bot allowlists.
- [Conversation behavior](activity.md): status, typing, reactions, queueing, steering, and events.
- [Memory](memory.md), [attachments](attachments.md), and [secrets](secrets.md).
- [Scheduling](scheduling.md) and [admin and audit](admin.md).

Adapter credentials and platform-specific behavior live under [Adapters](../adapters/index.md).

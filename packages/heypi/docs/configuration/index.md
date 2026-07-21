# Configuration

Configuration lives in TypeScript. heypi does not split settings across a JSON manifest and an
entrypoint.

## Agent

Pass model and execution settings to `loadAgent()`:

```ts
const agent = loadAgent("./agent", {
	id: "support",
	model: modelFromEnv(),
	runtime: docker({ image: "node:22-bookworm" }),
	state: { dir: ".heypi" },
	admin: {},
	tools: {
		bash: { approve: approval.command() },
		write: false,
	},
	todo: true,
	memory: true,
});
```

`id` defaults to the agent folder name. State defaults to `.heypi`. Todo and memory are enabled
unless set to `false`. Admin is disabled unless configured. Omitting `runtime` selects host execution
and emits a warning.

The admin server is unauthenticated only on loopback. Non-loopback binds require `admin.token`.
Wildcard binds such as `host: "0.0.0.0"` also require `hosts`, an explicit allowlist of accepted HTTP
hostnames.

## Adapters

Adapters own service credentials and chat behavior:

```ts
const chat = slack({
	id: "company-slack",
	token: process.env.SLACK_BOT_TOKEN!,
	appToken: process.env.SLACK_APP_TOKEN!,
	allow: { channels: ["C0123456789"] },
	admins: { users: ["U_ADMIN"] },
	approvers: { users: ["U_DEPLOYER"] },
	approvals: { layout: "message", timeoutMs: 60_000 },
	busy: "queue",
});

await runHeypi(agent, [chat]);
```

`allow` controls who can trigger the agent. `admins` receive administrative privileges and may
approve. `approvers` adds approval-only actors. Tool policy decides whether approval is required;
adapter configuration decides who can answer and how the request is rendered.

See [adapters](../adapters/index.md) for shared behavior and [scheduling](scheduling.md) for cron jobs.

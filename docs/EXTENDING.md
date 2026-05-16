# Extending

heypi is code-first. The main extension points are custom tools, confirmation rules, command risk classification, adapters, stores, attachments, and runtime options.

## Custom Tools

Pass tools through `agentFrom(..., { tools })`:

```ts
import { tool } from "@hunvreus/heypi";
import { Type } from "@sinclair/typebox";

const pageService = tool<{ service: string; reason: string }>({
	name: "page_service",
	description: "Record a service page request.",
	parameters: Type.Object({
		service: Type.String(),
		reason: Type.String(),
	}),
	confirm: ({ service }) => ({ reason: `Page ${service}` }),
	execute: async ({ service, reason }) => `page recorded: service=${service} reason=${reason}`,
});

agentFrom("./agent", {
	model: "openai/gpt-5-mini",
	tools: [pageService],
});
```

Use `tool()` when the tool needs confirmation. heypi stores the pending call, renders approval buttons where the adapter supports them, and can replay the tool after approval.

Raw Pi `ToolDefinition` objects are supported for tools that do not require confirmation. If a raw Pi tool includes `confirm`, heypi fails closed because it cannot safely replay the tool after approval.

## Confirmation

`confirm` can be a static reason:

```ts
confirm: { reason: "Deletes a ticket" }
```

Or a function that receives tool arguments:

```ts
confirm: ({ ticket }) => ticket ? { reason: `Delete ticket ${ticket}` } : false
```

Return `false` or `undefined` to allow the call without approval.

Approvers are configured at the app level:

```ts
approval: {
	approvers: ["U123456"],
	expiresInMs: 10 * 60 * 1000,
}
```

An empty or omitted `approvers` list means any user in that chat can approve.

## Built-In Tools

heypi registers Pi-compatible runtime tools:

```text
bash, read, write, edit, grep, find, ls, history
```

`bash` is governed through command risk classification, approval, audit rows, queueing, and the configured runtime. `read`, `write`, `edit`, `grep`, `find`, and `ls` run inside the runtime workspace and enforce runtime limits. `write` and `edit` do not require approval by default.

## Command Risk

heypi classifies shell commands before running the built-in `bash` tool. The classifier is a guardrail, not a sandbox. Use `just-bash` for team-facing isolation.

Default hard blocks include commands such as `rm -rf /`, `mkfs`, `shutdown`, and `reboot`. Default approval patterns include commands such as `curl`, `wget`, `ssh`, `docker`, `kubectl`, `terraform`, `helm`, `git push`, and package publishing.

Customize command classification with top-level `policy.command`:

```ts
createHeypi({
	// ...
	policy: {
		command: {
			allow: [/^curl -I https:\/\/status\.example\.com\b/],
			approve: [/\bmake deploy\b/],
			block: [/\bgh repo delete\b/],
		},
	},
});
```

Evaluation order:

1. custom `block`
2. built-in hard blocks
3. custom `allow`
4. custom `approve`
5. built-in approval patterns
6. allow

Custom `allow` patterns can bypass approval patterns. They cannot bypass built-in or custom block patterns.

You can also classify commands directly in custom tool logic:

```ts
import { classifyCommand, tool } from "@hunvreus/heypi";
import { Type } from "@sinclair/typebox";

const deploy = tool<{ command: string }>({
	name: "deploy",
	description: "Run a deploy command.",
	parameters: Type.Object({ command: Type.String() }),
	confirm: ({ command }) => {
		const risk = classifyCommand(String(command), {
			approve: [/\bdeploy\b/],
		});
		return risk.risk === "approval" ? { reason: risk.reason } : false;
	},
	execute: async ({ command }) => `would run ${command}`,
});
```

`classifyCommand()` only reports risk. The caller decides whether that means allow, request approval, or block.

## Other Extension Points

- Custom adapters implement the `Adapter` interface.
- Custom stores implement the `Store` interface.
- Custom attachment stores implement `AttachmentStore`.
- Runtime behavior is configured through `runtime`, including `justBash`, `hostEnv`, timeouts, concurrency, and file limits.

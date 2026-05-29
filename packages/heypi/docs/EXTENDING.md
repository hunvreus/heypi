# Extending

heypi is code-first. The main extension points are core tools, custom tools, confirmation rules, command risk classification, adapters, stores, attachments, and runtime options.

## Custom Tools

Omit `tools` to use the default core tool set. If you pass `tools`, include `coreTools()` explicitly:

```ts
import { coreTools, tool } from "@hunvreus/heypi";
import { Type } from "@sinclair/typebox";

const pageService = tool<{ service: string; reason: string }>({
	name: "page_service",
	description: "Record a service page request.",
	parameters: Type.Object({
		service: Type.String(),
		reason: Type.String(),
	}),
	confirm: ({ service }) => ({ message: `Page ${service}.` }),
	execute: async ({ service, reason }) => `page recorded: service=${service} reason=${reason}`,
});

agentFrom("./agent", {
	model: "openai/gpt-5-mini",
	tools: [...coreTools(), pageService],
});
```

Use `tool()` when the tool needs confirmation. heypi stores the pending call, renders approval buttons where the adapter supports them, and can replay the tool after approval.

`tool().execute` runs as trusted application code in the Node process. The second argument is the execution context. Use `ctx.runtime` when the tool wants command or file work to go through the selected runtime:

```ts
const inspectWorkspace = tool({
	name: "inspect_workspace",
	description: "List files in the active runtime workspace.",
	parameters: Type.Object({}),
	execute: async (_params, ctx) => {
		const result = await ctx.runtime.bash?.({ command: "find . -maxdepth 2 -type f", signal: ctx.signal });
		return result?.out ?? "runtime does not support bash";
	},
});
```

The runtime context is scoped to the current turn. Custom tool JavaScript itself is not sandboxed; the app developer owns that code.

Raw Pi `ToolDefinition` objects are supported for tools that do not require confirmation. If a raw Pi tool includes `confirm`, heypi fails closed because it cannot safely replay the tool after approval.

## Dynamic Context

Use `agentFrom(..., { context })` to append small runtime context blocks to the system prompt for each turn:

```ts
agentFrom("./agent", {
	model: "openai/gpt-5-mini",
	context: [
		async ({ channel, actor }) => ({
			title: "Request context",
			text: [`channel=${channel}`, `actor=${actor}`].join("\n"),
		}),
	],
});
```

Context is for facts the model should see before choosing tools: known hosts, tenant metadata, user profile, current on-call rotation, feature flags, or channel policy. Keep it compact. Use tools for large data, search, or actions.

## Confirmation

`confirm` controls whether a tool call needs approval. It can be a static message:

```ts
confirm: { message: "Delete a ticket." }
```

Or a function that receives tool arguments:

```ts
confirm: ({ ticket }) => ticket ? { message: `Delete ticket ${ticket}.` } : false
```

Return `false` or `undefined` to allow the call without approval. Return `{ block: "reason" }` to block the call without asking for approval.

Use `message` for user-facing approval copy. `reason` is accepted for compatibility and is also user-facing when `message` is omitted. Use `policyReason` only for policy/audit detail, such as the command pattern that triggered approval; adapters do not show it as the main approval text.

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

Use `coreTools()` to include and configure them:

```ts
import { commandConfirm, coreTools } from "@hunvreus/heypi";

agentFrom("./agent", {
	model: "openai/gpt-5-mini",
	tools: [
		...coreTools({
			bash: { confirm: commandConfirm() },
			write: false,
			edit: false,
		}),
		pageService,
	],
});
```

`coreTools()` defaults to all core tools with `commandConfirm()` on `bash`. `bash: true` enables bash without command confirmation. `false` disables a core tool. `read`, `write`, `edit`, `grep`, `find`, and `ls` run inside the runtime workspace and enforce path containment plus runtime limits. `write` and `edit` do not require approval by default.

## Command Risk

`commandConfirm()` adapts command risk classification to the normal tool `confirm` contract. The classifier is a guardrail, not a sandbox. Use `just-bash` for team-facing isolation.

Default hard blocks include commands such as `rm -rf /`, `mkfs`, `shutdown`, and `reboot`. Default approval patterns include commands such as `curl`, `wget`, `ssh`, `docker`, `kubectl`, `terraform`, `helm`, firewall changes (`ufw`, `firewall-cmd`, `iptables`, `nft`), `git push`, and package publishing.

`just-bash` network access is disabled by default. Without `runtime.justBash.network`, commands such as `curl` are unavailable. Enable only what the agent needs:

```ts
runtime: {
	name: "just-bash",
	root: workspace("./workspace"),
	justBash: {
		network: {
			allowedUrlPrefixes: ["https://docs.example.com"],
		},
	},
}
```

For trusted/dev agents that need arbitrary public documentation lookup:

```ts
runtime: {
	name: "just-bash",
	root: workspace("./workspace"),
	justBash: {
		network: { dangerouslyAllowFullInternetAccess: true },
	},
}
```

Customize bash command confirmation through `coreTools()`:

```ts
agentFrom("./agent", {
	model: "openai/gpt-5-mini",
	tools: [
		...coreTools({
			bash: {
				confirm: commandConfirm({
					allow: [/^curl -I https:\/\/status\.example\.com\b/],
					approve: [/\bmake deploy\b/],
					block: [/\bgh repo delete\b/],
				}),
			},
		}),
	],
});
```

Command strings are parsed before policy evaluation. Each simple command segment is classified separately, and the highest risk wins. This means an `allow` rule for `curl -I http://127.0.0.1` can allow that segment, but it cannot allow `sudo ufw allow 8090/tcp && curl -I http://127.0.0.1`. If the shell cannot be parsed, classification fails closed and requires approval.

Evaluation order per parsed segment:

1. custom `block`
2. built-in hard blocks
3. custom `allow`
4. custom `approve`
5. built-in approval patterns
6. allow

Custom `allow` patterns can bypass approval patterns for the matching segment. They cannot bypass built-in or custom block patterns, and they do not allow other segments in the same compound command.

You can reuse `commandConfirm()` directly in custom tool logic:

```ts
import { commandConfirm, tool } from "@hunvreus/heypi";
import { Type } from "@sinclair/typebox";

const deployConfirm = commandConfirm({
	approve: [/\bdeploy\b/],
});

const deploy = tool<{ command: string }>({
	name: "deploy",
	description: "Run a deploy command.",
	parameters: Type.Object({ command: Type.String() }),
	confirm: ({ command }) => {
		const result = deployConfirm({ command });
		return result
			? {
					...result,
					message: "Run deployment command.",
					details: [{ label: "Command", value: command, format: "code" }],
				}
			: false;
	},
	execute: async ({ command }) => `would run ${command}`,
});
```

Approval prompts render the same structured fields in Slack, Telegram, and Discord. `message` is the user-facing reason; `policyReason` is audit context. Use `details` for visible fields:

```ts
details: [
	{ label: "Target", value: "prod-web-1" },
	{ label: "Command", value: "systemctl restart app", format: "code" },
]
```

Omit `details` when there is nothing useful to show. Core bash confirmations include a `Command` code field by default; custom tools should provide their own domain-specific details instead of relying on command parsing.

Keep detail values concise. Adapters preserve the same fields, but provider message limits still apply; put large outputs in files or normal tool results, not approval cards.

`classifyCommand()` is still exported for lower-level use, but most code should use `commandConfirm()`.

## Other Extension Points

Advanced extension contracts live on explicit subpaths:

```ts
import type { Adapter } from "@hunvreus/heypi/adapter";
import type { AttachmentStore } from "@hunvreus/heypi/attachments";
import type { RuntimeProvider } from "@hunvreus/heypi/runtime";
import type { Store } from "@hunvreus/heypi/store";
```

- Custom adapters implement the `Adapter` interface.
- Custom stores implement the `Store` interface. Production shared stores must provide durable `locks`; scheduler-capable stores also need `jobs` and `jobRuns`. Implement `transaction()` when multiple repository updates must commit atomically.
- Custom attachment stores implement `AttachmentStore` and are configured with `attachments: { store }`. Stores receive the current scope on save/resolve and should reject cross-scope refs.
- Attachment processing is configured with `attachments.process`; document conversion is optional and should run through a local converter with byte, time, and output limits. The bundled document converter requires Python 3 and either `uv` or MarkItDown installed in the Python environment.
- Custom runtime packages implement `RuntimeProvider` and are configured with `runtime.provider`. Managed providers can keep scoped runtimes warm and clean them up from `close()`.
- Official runtime provider packages are `@hunvreus/heypi-runtime-docker` and `@hunvreus/heypi-runtime-gondolin`. They run bash and file/search tools through the selected scoped sandbox; each package README documents its system dependencies and quickstart.
- Built-in runtime behavior is configured through `runtime`, including `justBash`, `hostEnv`, timeouts, process limits, file limits, and `runtime.scope`.
- Pi extensions are loaded from explicit `agent.extensions` paths or `agent/extensions/`. heypi disables Pi's default/global extension discovery; configure each chat agent's extension set directly.
  Extension code runs in-process and should be treated as trusted application code. Interactive Pi extension UI and slash-command flows are not exposed as first-class chat features.

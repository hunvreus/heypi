# Tools

Tools are how the agent reads files, runs commands, sends generated files, and calls trusted app code.

## Core tools

`coreTools()` exposes heypi's built-in runtime tools. By default, it returns:

```text
bash, read, write, edit, grep, find, ls, attach, history
```

These run through the selected runtime when the runtime implements the operation. `attach` marks a generated runtime file for upload with the final chat reply.

Configure core tools with `coreTools()`:

```ts
import { commandConfirm, coreTools } from "@hunvreus/heypi";

agentFrom("./agent", {
	model: "openai/gpt-5.4-mini",
	tools: [
		...coreTools({
			bash: { confirm: commandConfirm() },
			write: false,
			edit: false,
		}),
	],
});
```

`bash` uses command confirmation by default. Use `bash: true` only for trusted agents where commands should run without approval.

### Options

| Option | Default | Description |
| --- | --- | --- |
| `bash` | `{ confirm: commandConfirm() }` | Run shell commands through the selected runtime. Pass `true` to remove default confirmation, `false` to disable, or `{ confirm }` to customize approval. |
| `read` | `true` | Read runtime files. |
| `write` | `true` | Write runtime files. |
| `edit` | `true` | Edit runtime files. |
| `grep` | `true` | Search runtime file contents. |
| `find` | `true` | Find runtime files by path/name. |
| `ls` | `true` | List runtime directories. |
| `attach` | `true` | Attach a generated runtime file to the final chat reply. |
| `history` | `true` | Search current-thread message history. |

Each option accepts `false`, `true`, or `{ confirm }`. Only `bash` has a confirmation policy by default.

## Custom tools

Custom tools run as trusted JavaScript in the Node app process:

```ts
import { tool } from "@hunvreus/heypi";
import { Type } from "@sinclair/typebox";

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

Use `ctx.runtime` when a custom tool wants command or file work to follow the selected runtime.

### Options

| Option | Required | Description |
| --- | --- | --- |
| `name` | Yes | Tool name exposed to the model. Use stable, lowercase names such as `inspect_workspace`. |
| `description` | Yes | Short model-facing description of when to use the tool. |
| `parameters` | Yes | Pi-compatible parameter schema, commonly a TypeBox schema. |
| `execute` | Yes | Trusted JavaScript handler. Receives parsed input and `{ runtime, runtimeScope, signal }`. |
| `label` | No | Human label for approvals and logs. Defaults to `name`. |
| `confirm` | No | Confirmation policy for this tool. See [Confirmation](#confirmation). |

## Trust boundary

Custom tools and Pi extensions run as trusted JavaScript in the Node app process. They have the same filesystem, network, env var, database, and SDK access as the app itself.

Use `ctx.runtime` when shell or file work should go through the selected runtime. The JavaScript tool body itself is not sandboxed.

## Confirmation

`confirm` controls whether a tool call needs approval:

```ts
const pageService = tool({
	name: "page_service",
	description: "Record a service page request.",
	parameters: Type.Object({
		service: Type.String(),
		reason: Type.String(),
	}),
	confirm: ({ service }) => ({ message: `Page ${service}.` }),
	execute: async ({ service, reason }) => `page recorded: service=${service} reason=${reason}`,
});
```

Return values:

| Return value | Effect |
| --- | --- |
| `undefined` or `false` | Allow the call immediately. |
| `{ message }` or `{ reason }` | Ask for approval before running. |
| `{ block }` | Block the call without asking for approval. |
| `{ details }` | Add fields to the approval card. Use with `message` or `reason`. |
| `{ policyReason }` | Internal/audit reason for why this policy matched. |

For approval cards, use `message` plus optional `details`:

```ts
confirm: ({ command }) => ({
	message: "Run deployment command.",
	details: [{ label: "Command", value: command, format: "code" }],
})
```

`commandConfirm()` classifies bash commands. It blocks destructive commands, asks for approval for risky commands, and allows low-risk commands.

```ts
coreTools({
	bash: {
		confirm: commandConfirm({
			allow: [/^curl -I https:\/\/status\.example\.com\b/],
			approve: [/\bmake deploy\b/],
			block: [/\bgh repo delete\b/],
		}),
	},
});
```

The classifier is a guardrail, not a sandbox. Use `just-bash`, Docker, Gondolin, or another runtime provider for isolation.

## Managed tools

Some top-level feature config adds tools automatically. These tools are not returned by `coreTools()` and do not need to be listed manually in `agent.tools`.

| Feature config | Added tools | What they do |
| --- | --- | --- |
| [`memory`](memory.md) | `memory_read`, `memory_write`, `memory_replace`, `memory_delete` | Let the agent read and update scoped durable memory. |
| [`skills`](skills.md) | `skill_list`, `skill_read`, `skill_write`, `skill_patch`, `skill_delete` | Let the agent manage scoped runbooks/procedures stored by heypi. |
| [`secrets`](secrets.md) | `secret_request` | Let the agent ask the user for encrypted secrets and receive scoped file paths, not raw secret values in chat. |

Managed tools follow their feature's policy. For example, memory and skills writes are controlled by their `writePolicy`; secret requests require `secrets.enabled`.

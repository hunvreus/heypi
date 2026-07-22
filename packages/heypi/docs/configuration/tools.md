# Tools

Pi owns tool discovery and execution. heypi supplies runtime-backed core tools, chat tools, and a
typed map for disabling, approving, or registering tools by name.

```ts
const agent = loadAgent("./agent", {
	tools: {
		bash: { approve: approval.command() },
		write: false,
	},
});
```

- `false` disables a built-in or discovered tool.
- `{ approve }` wraps a tool with an approval policy.
- A Pi `ToolDefinition` registers a code-defined tool.

Invalid entries fail during startup. Tool names must match the Pi tool name, not the source filename.

## Built-in chat tools

heypi registers:

- `chat_history` for explicit access to older platform messages;
- `chat_attach` for sending files from `/workspace` or `/shared`;
- `chat_request_secret` for encrypted credential collection;
- `todo` when todo support is enabled;
- `memory` and `memory_search` when memory is enabled.

Runtime providers own the seven Pi core file and command tools. Setting `noTools` changes Pi's core
tool registration and should normally be left unset.

## Authored tools

Put application tools in `agent/tools/`. They are loaded as trusted Pi extension modules and can
register one or more tools. Keep schemas narrow and results compact. Put tool-specific usage rules in
the tool description and reserve prompt guidance for cross-tool invariants.

Custom tools run in the trusted Node.js process unless they explicitly call a sandboxed runtime or
external service. heypi cannot inspect side effects hidden inside them, so apply approval by tool
name where required.

See [Create a custom tool](../guides/custom-tools.md).

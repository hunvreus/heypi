# Create a custom tool

Put authored tool modules in `agent/tools/`. Each file is a Pi extension that registers one or more
tools.

```ts
import { defineTool, type ExtensionAPI, Type } from "@hunvreus/heypi/authoring";

const echo = defineTool({
	name: "echo",
	label: "Echo",
	description: "Return text unchanged.",
	parameters: Type.Object({ text: Type.String() }),
	async execute(_id, input) {
		return { content: [{ type: "text", text: input.text }] };
	},
});

export default function register(pi: ExtensionAPI) {
	pi.registerTool(echo);
}
```

Keep schemas narrow and results compact. Put tool-specific usage rules in the tool description so
they travel with the schema. Reserve `promptGuidelines` for short invariants that must also appear
in Pi's system guidance. Tool modules are trusted application code.

## Side effects and approvals

heypi cannot inspect commands hidden inside a custom tool. Prefer runtime-backed Pi tools for shell
and file effects. If a custom tool performs a risky trusted-side action, approve it by tool name:

```ts
const agent = loadAgent("./agent", {
	tools: {
		deploy_prod: { approve: approval.always("Deploy production.") },
	},
});
```

Use `false` to disable a tool and `{ approve }` to wrap one. Invalid tool map entries fail at startup.

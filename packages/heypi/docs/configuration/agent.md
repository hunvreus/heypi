# Agent configuration

The `agent` config defines the Pi agent heypi runs for each accepted turn: model, prompts, tools, dynamic context, skills, and Pi extensions.

## Config

Use `agentFrom()` for folder-based agents:

```ts
createHeypi({
	agent: agentFrom("./agent", {
		model: "openai/gpt-5.4-mini",
		tools: [...coreTools()],
	}),
	// ...state, adapters, runtime
});
```

Use a manual Pi-compatible agent config when you do not want heypi's folder convention:

```ts
createHeypi({
	agent: {
		id: "ops",
		directory: process.cwd(),
		model: { provider: "openai", name: "gpt-5.4-mini" },
		prompt: "You are a concise operations assistant.",
		soul: "Answer directly. Ask when blocked.",
		tools: [...coreTools()],
	},
	// ...state, adapters, runtime
});
```

## Options

| Option | Required | Applies to | Description |
| --- | --- | --- | --- |
| `model` | Yes, unless `HEYPI_MODEL` is set | `agentFrom`, manual | Model id. `agentFrom()` accepts Pi's `provider/name` string, such as `openai/gpt-5.4-mini`. Manual config uses Pi's lower-level model shape. |
| `tools` | No | `agentFrom`, manual | Core tools, managed tools, and custom trusted JS tools exposed to the agent. See [Tools](tools.md). |
| `context` | No | `agentFrom`, manual | Per-turn context blocks added before the model chooses tools. |
| `systemPrompt` | No | `agentFrom` | Explicit system prompt. Replaces `SYSTEM.md` and heypi's generated default. |
| `prompt` | No | manual | Main prompt text for the Pi agent. |
| `soul` | No | manual | Voice and behavior text for the Pi agent. |
| `directory` | Yes | manual | Agent working directory and base path for relative Pi skill or extension paths. |
| `skills` | No | `agentFrom`, manual | Explicit Pi-native skill paths. Bundled folder skills are loaded from `agent/skills/` when using `agentFrom()`. |
| `extensions` | No | `agentFrom`, manual | Explicit Pi extension paths. Folder extensions are loaded from `agent/extensions/` when using `agentFrom()`. |

For the full lower-level Pi agent contract, see Pi's [coding-agent package](https://github.com/earendil-works/pi/tree/main/packages/coding-agent).

## Prompt files

`agentFrom("./agent", ...)` loads these files:

| Path | Description |
| --- | --- |
| `SYSTEM.md` | System-level operating rules. Replaces heypi's generated system prompt when present. |
| `SOUL.md` | Voice and behavior. Uses heypi's concise fallback when omitted. |
| `AGENTS.md` | Main app instructions. No default. |
| `skills/` | Bundled skills loaded with the agent. Empty when absent. |
| `extensions/` | Explicit Pi extensions loaded with the agent. Empty when absent. |

`skills/` loads bundled skills from the agent folder. They ship with the app and are not managed by `skill_*` tools. Runtime-created managed skills are enabled with top-level [`skills`](skills.md) config.

Prompt order is: `SYSTEM.md` or heypi's generated system prompt, then `SOUL.md`, `AGENTS.md`, and dynamic context blocks.

When `SYSTEM.md` and `systemPrompt` are omitted, heypi generates a system prompt from the active tool set:

```text
Use available tools when needed. Prefer the narrowest available tool that directly matches the task. Do not say you used a tool unless you actually called it.

Approvals are handled by the runtime. Do not ask users to approve tool calls in plain text.
```

heypi also adds tool-specific guidance, such as preferring file/search tools for file exploration or using `attach` for meaningful generated files.

When `SOUL.md` and `soul` are omitted, heypi uses:

```text
You are a concise, practical assistant.
Answer directly and accurately. Say when you are uncertain or blocked.
Use plain language and keep responses focused on the user's goal.
```

## Model credentials

heypi does not accept model API keys in `createHeypi()`. It passes the selected provider/model to Pi. Pi resolves credentials when the model call runs, from provider env vars or Pi auth state.

```bash
OPENAI_API_KEY=sk-... npx tsx index.ts
```

```ts
agent: agentFrom("./agent", { model: "openai/gpt-5.4-mini" });
```

Common provider env vars:

| Provider | Example model | Env var |
| --- | --- | --- |
| OpenAI | `openai/gpt-5.4-mini` | `OPENAI_API_KEY` |
| Anthropic | `anthropic/claude-sonnet-4-5` | `ANTHROPIC_API_KEY` |
| Google Gemini | `google/gemini-2.5-pro` | `GEMINI_API_KEY` |
| OpenRouter | `openrouter/...` | `OPENROUTER_API_KEY` |
| Vercel AI Gateway | `vercel-ai-gateway/...` | `AI_GATEWAY_API_KEY` |
| Cloudflare AI Gateway | `cloudflare-ai-gateway/...` | `CLOUDFLARE_API_KEY`, `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_GATEWAY_ID` |
| Amazon Bedrock | `amazon-bedrock/...` | AWS credentials such as `AWS_PROFILE` or workload credentials |

This list is intentionally partial. The canonical provider list belongs to Pi's provider layer; see Pi's [providers guide](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/providers.md).

## Dynamic context

Use `context` for compact facts that change per turn: current deployment, tenant id, configured hosts, channel metadata, or request actor.

```ts
agentFrom("./agent", {
	model: "openai/gpt-5.4-mini",
	context: [
		async ({ channel, actor }) => ({
			title: "Request context",
			text: [`channel=${channel}`, `actor=${actor}`].join("\n"),
		}),
	],
});
```

heypi also injects current channel context automatically. Memory and managed skills add their own context blocks when enabled. Secrets are stored as scoped runtime files and are not injected directly into the prompt.

Keep context small. Use tools for large data, search, or actions.

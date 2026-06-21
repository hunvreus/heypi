# Agent configuration

The `agent` config defines the Pi agent heypi runs for each accepted turn: model, prompts, built-in tools, authored tools, jobs, dynamic context, skills, and Pi extensions.

## Config

Use `loadAgent()` for folder-based agents:

```ts
createHeypi({
  agent: loadAgent("./agent", {
    model: "openai/gpt-5.4-mini",
  }),
  // ...state, adapters, runtime
});
```

That is equivalent to the default folder convention:

```ts
loadAgent("./agent", {
  model: "openai/gpt-5.4-mini",
  systemPrompt: loadPrompt("./agent/SYSTEM.md", { optional: true }),
  soul: loadPrompt("./agent/SOUL.md", { optional: true }),
  prompt: loadPrompt("./agent/AGENTS.md", { optional: true }),
  builtinTools: defaultTools(),
  tools: loadTools("./agent/tools"),
  jobs: loadJobs("./agent/jobs"),
  skills: ["./agent/skills"], // when present
  extensions: ["./agent/extensions"], // when present
});
```

Convention files are defaults. Passing an option overrides that category. For example, `tools: []` disables authored tools from `agent/tools/`; use `tools: [...loadTools("./agent/tools"), myTool]` when you want convention tools plus inline tools. This override is intentional and silent: if you pass `tools`, heypi does not also load `agent/tools/` unless you include `loadTools()` yourself. Built-in runtime tools belong in `builtinTools`; legacy `tools: defaultTools()` config is rejected.

Use a manual Pi-compatible agent config when you do not want heypi's folder convention:

```ts
createHeypi({
  agent: {
    id: "ops",
    directory: process.cwd(),
    model: { provider: "openai", name: "gpt-5.4-mini" },
    prompt: "You are a concise operations assistant.",
    soul: "Answer directly. Ask when blocked.",
    builtinTools: defaultTools(),
    tools: [myTool],
  },
  // ...state, adapters, runtime
});
```

## Options

| Option | Required | Applies to | Description |
| --- | --- | --- | --- |
| `id` | No | `loadAgent`, manual | Durable agent id for threads, jobs, approvals, traces, and app locking. Defaults to `default`; set it explicitly for multi-agent apps or when preserving state from an older id. |
| `model` | Yes, unless `HEYPI_MODEL` is set | `loadAgent`, manual | Model id. `loadAgent()` accepts Pi's `provider/name` string, such as `openai/gpt-5.4-mini`. Manual config uses Pi's lower-level model shape. |
| `builtinTools` | No | `loadAgent`, manual | Built-in heypi runtime tools. Defaults to `defaultTools()`. See [Tools](tools.md). |
| `tools` | No | `loadAgent`, manual | Authored trusted JS tools exposed to the agent. Defaults to `loadTools("./agent/tools")` when using `loadAgent()`. |
| `evals` | No | manual | Optional runtime-attached eval definitions. Normal eval discovery uses root `evals/` through `heypi eval`. |
| `context` | No | `loadAgent`, manual | Per-turn context blocks added before the model chooses tools. |
| `systemPrompt` | No | `loadAgent` | Explicit system prompt. Replaces `SYSTEM.md` and heypi's generated default. |
| `prompt` | No | manual | Main prompt text for the Pi agent. |
| `soul` | No | manual | Voice and behavior text for the Pi agent. |
| `directory` | Yes | manual | Agent working directory and base path for relative Pi skill or extension paths. |
| `skills` | No | `loadAgent`, manual | Explicit Pi-native skill paths. Bundled folder skills are loaded from `agent/skills/` when using `loadAgent()`. |
| `extensions` | No | `loadAgent`, manual | Explicit Pi extension paths. Folder extensions are loaded from `agent/extensions/` when using `loadAgent()`. |

For the full lower-level Pi agent contract, see Pi's [coding-agent package](https://github.com/earendil-works/pi/tree/main/packages/coding-agent).

## Prompt files

`loadAgent("./agent", ...)` loads these files and folders:

```text
agent/
|-- SYSTEM.md       # optional replacement for heypi's generated system prompt
|-- SOUL.md         # voice and behavior
|-- AGENTS.md       # main app instructions
|-- tools/          # trusted TypeScript tools
|-- jobs/           # scheduled jobs
|-- skills/         # bundled Pi skills
`-- extensions/     # explicit Pi extensions
```

| Path | Description |
| --- | --- |
| `SYSTEM.md` | System-level operating rules. Replaces heypi's generated system prompt when present. |
| `SOUL.md` | Voice and behavior. Uses heypi's concise fallback when omitted. |
| `AGENTS.md` | Main app instructions. No default. |
| `tools/` | Trusted TypeScript tools default-exported from module files under this folder. File stems become tool names when omitted. |
| `jobs/` | Scheduled jobs default-exported from module files under this folder. |
| `skills/` | Bundled skills loaded with the agent. Empty when absent. |
| `extensions/` | Explicit Pi extensions loaded with the agent. Empty when absent. |

`skills/` loads bundled skills from the agent folder. They ship with the app and are not managed by `skill_*` tools. Runtime-created managed skills are enabled with top-level [`skills`](skills.md) config.

Discovered tools and jobs are loaded recursively in lexical relative-path order. Passing `tools` or `jobs` overrides discovery for that category. Built-in runtime tools are configured separately through `builtinTools`.

Files discovered under `agent/tools/` and `agent/jobs/` should import authoring helpers from `@hunvreus/heypi/authoring`. Keep `@hunvreus/heypi` imports in app entrypoints such as `index.ts`, where adapters, state, runtime, and admin are wired.

`loadAgent()` uses `id: "default"` unless you pass `id`. This keeps generated apps, admin filters, CLI status, and persisted eval events on the same default agent id.

If top-level `jobs` is omitted from `createHeypi()`, jobs discovered under `agent/jobs/` are used. Top-level `jobs` remains the explicit override, including `jobs: []` to disable configured jobs.

Behavior evals normally live under root `evals/` and are discovered by `heypi eval`, not by the runtime agent. `heypi eval run` can check assertions against explicit supplied output, or run the eval prompt through a local Pi-backed heypi handler with `--model` or `HEYPI_MODEL`. Agent-backed evals use isolated temporary state by default and are meant for behavior checks, not workflow checkpoint replay.

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
agent: loadAgent("./agent", { model: "openai/gpt-5.4-mini" });
```

Common provider env vars:

| Provider | Example model | Env var |
| --- | --- | --- |
| OpenAI | `openai/gpt-5.4-mini` | `OPENAI_API_KEY` |
| Anthropic | `anthropic/claude-sonnet-4-5` | `ANTHROPIC_API_KEY` |
| Google Gemini | `google/gemini-2.5-pro` | `GEMINI_API_KEY` |
| OpenRouter | `openrouter/...` | `OPENROUTER_API_KEY` |
| Vercel AI Gateway | `vercel-ai-gateway/...` | `AI_GATEWAY_API_KEY` |
| Amazon Bedrock | `amazon-bedrock/...` | AWS credentials such as `AWS_PROFILE` or workload credentials |

This list is intentionally partial. The canonical provider list belongs to Pi's provider layer; see Pi's [providers guide](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/providers.md).

## Dynamic context

Use `context` for compact facts that change per turn: current deployment, tenant id, configured hosts, channel metadata, or request actor.

```ts
loadAgent("./agent", {
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

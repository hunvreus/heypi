export const defaultModel = "openai/gpt-5.4-mini";
export const customModel = "__custom__";

export const modelChoices = [
	{ label: "OpenAI GPT-5.4 mini", value: defaultModel, hint: "default, cost-aware coding and agents" },
	{ label: "OpenAI GPT-5.5", value: "openai/gpt-5.5", hint: "flagship reasoning and coding" },
	{ label: "OpenAI GPT-5.4", value: "openai/gpt-5.4", hint: "stronger than mini, cheaper than flagship" },
	{ label: "OpenAI GPT-5.4 nano", value: "openai/gpt-5.4-nano", hint: "lowest-latency OpenAI option" },
	{
		label: "Anthropic Claude Opus 4.8",
		value: "anthropic/claude-opus-4-8",
		hint: "frontier reasoning and long-horizon coding",
	},
	{
		label: "Anthropic Claude Sonnet 4.6",
		value: "anthropic/claude-sonnet-4-6",
		hint: "balanced speed and intelligence",
	},
	{ label: "Anthropic Claude Haiku 4.5", value: "anthropic/claude-haiku-4-5", hint: "fastest current Claude option" },
	{ label: "Google Gemini 3 Pro", value: "google/gemini-3-pro-preview", hint: "strong multimodal reasoning preview" },
	{ label: "Google Gemini 3 Flash", value: "google/gemini-3-flash-preview", hint: "fast multimodal preview" },
	{ label: "xAI Grok 4.3", value: "xai/grok-4.3", hint: "xAI flagship chat and tool-calling model" },
	{ label: "xAI Grok Build 0.1", value: "xai/grok-build-0.1", hint: "agentic coding model" },
	{ label: "Custom model", value: customModel, hint: "enter provider/model manually" },
] as const;

export type ModelChoice = (typeof modelChoices)[number]["value"];

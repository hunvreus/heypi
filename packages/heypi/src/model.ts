import { AuthStorage, ModelRegistry } from "@earendil-works/pi-coding-agent";
import type { ModelConfig } from "./types.js";

export function modelFromEnv(name = "HEYPI_MODEL"): ModelConfig | undefined {
	const value = process.env[name]?.trim();
	if (!value) return undefined;
	const slash = value.indexOf("/");
	if (slash <= 0 || slash === value.length - 1) {
		throw new Error(`${name} must use provider/model format, for example openai/gpt-5.4-mini`);
	}
	const provider = value.slice(0, slash);
	const modelId = value.slice(slash + 1);
	const model = ModelRegistry.create(AuthStorage.create()).find(provider, modelId);
	if (!model) throw new Error(`Unknown model ${value}`);
	return model as ModelConfig;
}

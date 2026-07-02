export type { ExtensionFactory, ToolDefinition } from "@earendil-works/pi-coding-agent";

/**
 * Prefer exporting Pi extensions from `agent/tools/`.
 *
 * heypi stages `agent/tools/*.ts` as Pi extension paths so tool execution stays
 * inside Pi. This helper only preserves the old authoring shape for simple
 * modules that already export a Pi `ToolDefinition`.
 */
export function defineTool<T>(tool: T): T {
	return tool;
}

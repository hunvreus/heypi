import { Type } from "@sinclair/typebox";
import { describe, expect, it } from "vitest";
import { toolSettings } from "../src/tool-config.js";
import type { AgentConfig } from "../src/types.js";

const baseAgent: AgentConfig = {
	id: "agent",
	root: ".",
};

describe("toolSettings", () => {
	it("rejects malformed tool entries", () => {
		expect(() =>
			toolSettings({
				...baseAgent,
				tools: {
					deploy: {
						description: "Deploy something",
						parameters: Type.Object({}),
					} as never,
				},
			}),
		).toThrow(/Invalid tools\.deploy/);
	});

	it("accepts built-in approval config and custom tool definitions", () => {
		const custom = {
			name: "deploy",
			label: "Deploy",
			description: "Deploy something",
			parameters: Type.Object({}),
			async execute() {
				return { content: [{ type: "text" as const, text: "ok" }], details: {} };
			},
		};
		const settings = toolSettings({
			...baseAgent,
			tools: {
				bash: { approve: false },
				write: false,
				deploy: custom,
			},
		});

		expect(settings.excludeTools).toEqual(["write"]);
		expect(settings.customTools).toEqual([custom]);
		expect(settings.approvalPolicies).toEqual({});
	});
});

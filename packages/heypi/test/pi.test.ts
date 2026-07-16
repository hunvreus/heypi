import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { createPiHost, createRuntimePromptExtension } from "../src/pi.js";
import type { AgentConfig } from "../src/types.js";

vi.mock("@earendil-works/pi-coding-agent", () => ({
	SessionManager: { create: () => ({}) },
	createAgentSession: vi.fn(),
	createAgentSessionRuntime: async () => {
		throw new Error("session startup failed");
	},
	createAgentSessionServices: vi.fn(),
}));

describe("Pi host", () => {
	it("replaces physical storage roots in the model-facing prompt", async () => {
		const on = vi.fn();
		const extension = createRuntimePromptExtension({
			agent: { id: "agent", root: "/host/source" },
			agentDir: "/host/state/agent",
			workspaceDir: "/host/state/workspace",
			sharedDir: "/host/state/shared",
			sessionDir: "/host/state/sessions/thread",
		});
		await extension({ on } as unknown as ExtensionAPI);
		const rewrite = on.mock.calls[0]?.[1] as (event: {
			systemPrompt: string;
		}) => { systemPrompt: string } | undefined;

		expect(
			rewrite({
				systemPrompt:
					"Current working directory: /host/state/workspace\n/host/state/shared/x\n/host/state/agent\n/host/state/sessions/thread",
			}),
		).toEqual({
			systemPrompt: "Current working directory: /workspace\n/shared/x\n/agent\n/sessions",
		});
	});

	it("cleans up runtime tools when session startup fails", async () => {
		let cleanups = 0;
		const agent: AgentConfig = {
			id: "agent",
			root: "/agent",
			runtime: {
				provider: async () => ({
					tools: [],
					async cleanup() {
						cleanups++;
					},
				}),
			},
		};
		const pi = createPiHost({
			agent,
			agentDir: "/agent",
			workspaceDir: "/workspace",
			sessionDir: "/session",
		});

		await expect(pi.start()).rejects.toThrow("session startup failed");
		expect(cleanups).toBe(1);
	});
});

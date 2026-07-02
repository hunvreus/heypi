import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { local } from "../src/adapters.js";
import { loadAgent } from "../src/agent.js";
import { createHeypi } from "../src/app.js";
import type { PiEvent, PiHost, PiHostOptions } from "../src/pi.js";

async function makeDir(name: string): Promise<string> {
	const root = join(tmpdir(), `heypi-${name}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	await mkdir(root, { recursive: true });
	return root;
}

describe("createHeypi", () => {
	it("routes triggered adapter messages through Pi and replies in the source thread", async () => {
		const root = await makeDir("app-agent");
		const state = await makeDir("app-state");
		const adapter = local();
		const prompts: string[] = [];
		const piOptions: PiHostOptions[] = [];

		const app = await createHeypi({
			agent: loadAgent(root, {
				id: "agent",
				adapters: [adapter],
				state: { dir: state },
				approvals: { enabled: false },
			}),
			piHost(options) {
				piOptions.push(options);
				const listeners: Array<(event: PiEvent) => void> = [];
				const host: PiHost = {
					async start() {},
					async send(text) {
						prompts.push(text);
						for (const listener of listeners) {
							listener({
								type: "message_end",
								message: { role: "assistant", content: "Done." },
							} as unknown as PiEvent);
						}
					},
					subscribe(listener) {
						listeners.push(listener);
						return () => {
							const index = listeners.indexOf(listener);
							if (index >= 0) listeners.splice(index, 1);
						};
					},
					async stop() {},
				};
				return host;
			},
		});

		await app.start();
		await adapter.receive({
			id: "m1",
			user: { id: "u1", name: "Ronan" },
			text: "hello",
		});
		await app.stop();

		expect(prompts).toEqual(["- [uid:u1] Ronan: hello"]);
		expect(adapter.sent).toEqual([{ conversation: "local", thread: "m1", text: "Done." }]);
		expect(piOptions).toHaveLength(1);
		expect(piOptions[0]?.tools).toHaveLength(2);
		expect(piOptions[0]?.agentDir).toBe(join(state, "agents", "agent", "agent"));
	});
});

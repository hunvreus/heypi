import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Type } from "@sinclair/typebox";
import {
	type Adapter,
	type AttachmentStore,
	agentFrom,
	consoleLogger,
	createHeypi,
	sqliteStore,
	tool,
	workspace,
} from "heypi";

test("public package entrypoint supports a minimal app config", async () => {
	const root = await mkdtemp(join(tmpdir(), "heypi-public-api-"));
	try {
		const adapter: Adapter = {
			start: async () => undefined,
			stop: async () => undefined,
		};
		const lookup = tool<{ name: string }>({
			name: "lookup",
			description: "Lookup a value",
			parameters: Type.Object({ name: Type.String() }),
			execute: async ({ name }) => `name=${name}`,
		});
		const app = createHeypi({
			store: sqliteStore({ path: join(root, "heypi.db") }),
			logger: consoleLogger({ level: "error", format: "pretty" }),
			adapters: [adapter],
			agent: agentFrom("./examples/slack-devops/agent", { tools: [lookup] }),
			runtime: {
				name: "just-bash",
				root: workspace(join(root, "workspace")),
			},
		});
		assert.equal(typeof app.start, "function");
		assert.equal(typeof app.stop, "function");
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("createHeypi passes injected attachment store to adapters", async () => {
	const root = await mkdtemp(join(tmpdir(), "heypi-public-api-attachments-"));
	try {
		let received: AttachmentStore | undefined;
		const attachments: AttachmentStore = {
			save: async () => ({ name: "in.txt", path: "in.txt" }),
			resolve: async () => ({ name: "out.txt", path: join(root, "out.txt"), size: 0 }),
		};
		const adapter: Adapter = {
			start: async (input) => {
				received = input.attachments;
			},
		};
		const app = createHeypi({
			store: sqliteStore({ path: join(root, "heypi.db") }),
			logger: consoleLogger({ level: "error", format: "pretty" }),
			adapters: [adapter],
			attachments,
			agent: agentFrom("./examples/slack-devops/agent"),
			runtime: {
				name: "host-bash",
				root: workspace(join(root, "workspace")),
			},
		});

		await app.start();

		assert.equal(received, attachments);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

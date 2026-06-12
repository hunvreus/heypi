import assert from "node:assert/strict";
import { test } from "node:test";
import type { DiscordConfig, SlackConfig, TelegramConfig, WebhookConfig } from "@hunvreus/heypi";
import { consoleLogger, discord, slack, telegram, webhook } from "@hunvreus/heypi";
import type { Logger } from "../src/core/log.js";

test("built-in adapters reject stale permission keys", () => {
	assert.throws(
		() =>
			slack({
				botToken: "bot-token",
				mode: "socket",
				appToken: "app-token",
				approvers: [],
			} as unknown as SlackConfig),
		/slack\.approvers is not a valid key\. Approvers must be set at slack\.permissions\.approvers\./,
	);
	assert.throws(
		() => discord({ token: "token", admins: [] } as unknown as DiscordConfig),
		/discord\.admins is not a valid key\. Admins must be set at discord\.permissions\.admins\./,
	);
	assert.throws(
		() => telegram({ token: "token", approvers: [] } as unknown as TelegramConfig),
		/telegram\.approvers is not a valid key\. Approvers must be set at telegram\.permissions\.approvers\./,
	);
	assert.throws(
		() => webhook({ secret: "secret", approvers: [] } as unknown as WebhookConfig),
		/webhook\.approvers is not a valid key\. Approvers must be set at webhook\.permissions\.approvers\./,
	);
});

test("built-in adapters reject non-object allow and permissions config", () => {
	assert.throws(
		() =>
			slack({ botToken: "bot-token", mode: "socket", appToken: "app-token", allow: [] } as unknown as SlackConfig),
		/slack\.allow must be an object/,
	);
	assert.throws(
		() => discord({ token: "token", permissions: [] } as unknown as DiscordConfig),
		/discord\.permissions must be an object/,
	);
	assert.throws(
		() => telegram({ token: "token", allow: true } as unknown as TelegramConfig),
		/telegram\.allow must be an object/,
	);
	assert.throws(
		() => webhook({ secret: "secret", permissions: "U1" } as unknown as WebhookConfig),
		/webhook\.permissions must be an object/,
	);
});

test("built-in adapters warn for unknown config keys on start", async () => {
	const warnings: Array<Record<string, unknown> | undefined> = [];
	const logger: Logger = {
		...consoleLogger({ level: "error", format: "pretty" }),
		warn: (_event, input) => warnings.push(input),
	};
	const adapter = webhook({ secret: "secret", typo: true } as unknown as WebhookConfig);

	await adapter.start({
		handler: async () => ({ text: "ok" }),
		logger,
		http: { register: () => undefined },
	});

	assert.deepEqual(warnings, [{ path: "webhook.typo" }]);
});

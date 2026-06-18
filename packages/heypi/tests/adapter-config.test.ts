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

test("built-in adapters read conventional env vars by default", () => {
	const previous = {
		SLACK_BOT_TOKEN: process.env.SLACK_BOT_TOKEN,
		SLACK_APP_TOKEN: process.env.SLACK_APP_TOKEN,
		SLACK_SIGNING_SECRET: process.env.SLACK_SIGNING_SECRET,
		DISCORD_BOT_TOKEN: process.env.DISCORD_BOT_TOKEN,
		DISCORD_CLIENT_ID: process.env.DISCORD_CLIENT_ID,
		TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN,
		TELEGRAM_WEBHOOK_SECRET: process.env.TELEGRAM_WEBHOOK_SECRET,
		WEBHOOK_SECRET: process.env.WEBHOOK_SECRET,
	};
	try {
		process.env.SLACK_BOT_TOKEN = "slack-bot";
		process.env.SLACK_APP_TOKEN = "slack-app";
		process.env.SLACK_SIGNING_SECRET = "slack-signing";
		process.env.DISCORD_BOT_TOKEN = "discord-bot";
		process.env.DISCORD_CLIENT_ID = "discord-client";
		process.env.TELEGRAM_BOT_TOKEN = "telegram-bot";
		process.env.TELEGRAM_WEBHOOK_SECRET = "telegram-webhook";
		process.env.WEBHOOK_SECRET = "webhook-secret";

		assert.equal(slack().name, "slack");
		assert.equal(slack({ mode: "http" }).name, "slack");
		assert.equal(discord().name, "discord");
		assert.equal(telegram().name, "telegram");
		assert.equal(telegram({ mode: "webhook" }).name, "telegram");
		assert.equal(webhook().name, "webhook");
	} finally {
		for (const [key, value] of Object.entries(previous)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	}
});

test("built-in adapter env defaults fail loudly when required env vars are missing", () => {
	const previous = {
		SLACK_BOT_TOKEN: process.env.SLACK_BOT_TOKEN,
		DISCORD_BOT_TOKEN: process.env.DISCORD_BOT_TOKEN,
		TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN,
		HEYPI_WEBHOOK_SECRET: process.env.HEYPI_WEBHOOK_SECRET,
		WEBHOOK_SECRET: process.env.WEBHOOK_SECRET,
	};
	try {
		delete process.env.SLACK_BOT_TOKEN;
		delete process.env.DISCORD_BOT_TOKEN;
		delete process.env.TELEGRAM_BOT_TOKEN;
		delete process.env.HEYPI_WEBHOOK_SECRET;
		delete process.env.WEBHOOK_SECRET;

		assert.throws(() => slack(), /Slack bot token is required/);
		assert.throws(() => discord(), /Discord bot token is required/);
		assert.throws(() => telegram(), /Telegram bot token is required/);
		assert.throws(() => webhook(), /Webhook secret is required/);
	} finally {
		for (const [key, value] of Object.entries(previous)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	}
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

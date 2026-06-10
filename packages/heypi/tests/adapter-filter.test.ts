import assert from "node:assert/strict";
import { test } from "node:test";
import { discordAllowed, discordBotAllowed, discordTriggered } from "../src/io/discord.js";
import {
	approvalBlocks,
	slack,
	slackAllowed,
	slackBotAllowed,
	slackMessageSubtypeAllowed,
	slackTriggered,
} from "../src/io/slack.js";
import { telegramAllowed, telegramBotAllowed, telegramTriggered } from "../src/io/telegram.js";

test("Slack allowlists default to accepting delivered message events", () => {
	assert.deepEqual(slackAllowed(undefined, { channel: "C1", user: "U1", isDm: false }), { ok: true });
	assert.deepEqual(slackAllowed(undefined, { channel: "C1", user: undefined, isDm: false }), {
		ok: true,
	});
	assert.deepEqual(slackAllowed(undefined, { channel: "D1", user: "U1", isDm: true }), { ok: true });
});

test("Slack allowlists reject mismatched dimensions and disabled DMs", () => {
	assert.deepEqual(slackAllowed({ channels: ["C2"] }, { channel: "C1", user: "U1", isDm: false }), {
		ok: false,
		reason: "channel_not_allowed",
	});
	assert.deepEqual(slackAllowed({ users: ["U2"] }, { channel: "C1", user: "U1", isDm: false }), {
		ok: false,
		reason: "actor_not_allowed",
	});
	assert.deepEqual(slackAllowed({ groups: ["S1"] }, { channel: "C1", user: "U1", groups: ["S1"], isDm: false }), {
		ok: true,
	});
	assert.deepEqual(
		slackAllowed({ users: ["U2"], groups: ["S1"] }, { channel: "C1", user: "U1", groups: ["S1"], isDm: false }),
		{
			ok: true,
		},
	);
	assert.deepEqual(slackAllowed({ dms: false }, { channel: "D1", user: "U1", isDm: true }), {
		ok: false,
		reason: "dm_not_allowed",
	});
	assert.deepEqual(slackAllowed({ channels: ["C1"], dms: true }, { channel: "D1", user: "U1", isDm: true }), {
		ok: true,
	});
});

test("Slack trigger defaults to mention for channels and message for DMs", () => {
	assert.deepEqual(slackTriggered(undefined, { text: "hello", isDm: false, botUserId: "UBOT" }), {
		ok: false,
		reason: "mention_required",
	});
	assert.deepEqual(slackTriggered(undefined, { text: "hello <@UBOT>", isDm: false, botUserId: "UBOT" }), { ok: true });
	assert.deepEqual(slackTriggered(undefined, { text: "/approve A1", isDm: false, botUserId: "UBOT" }), { ok: true });
	assert.deepEqual(slackTriggered("message", { text: "hello", isDm: false, botUserId: "UBOT" }), { ok: true });
	assert.deepEqual(slackTriggered(undefined, { text: "hello", isDm: true, botUserId: "UBOT" }), { ok: true });
	assert.deepEqual(slackTriggered(undefined, { text: "follow up", isDm: false, botUserId: "UBOT", thread: true }), {
		ok: true,
	});
	assert.deepEqual(
		slackTriggered(undefined, {
			text: "follow up",
			isDm: false,
			botUserId: "UBOT",
			thread: true,
			threadTrigger: "mention",
		}),
		{
			ok: false,
			reason: "mention_required",
		},
	);
});

test("Slack allows normal messages and file shares", () => {
	assert.equal(slackMessageSubtypeAllowed(undefined), true);
	assert.equal(slackMessageSubtypeAllowed("file_share"), true);
	assert.equal(slackMessageSubtypeAllowed("message_changed"), false);
	assert.equal(slackMessageSubtypeAllowed("message_changed", true), false);
	assert.equal(slackMessageSubtypeAllowed("bot_message"), false);
	assert.equal(slackMessageSubtypeAllowed("bot_message", true), true);
});

test("Slack bot allowlist defaults closed and supports explicit all bots", () => {
	const self = { botId: "B_SELF" };
	assert.equal(slackBotAllowed(undefined, { botId: "B_TEST" }, self), false);
	assert.equal(slackBotAllowed([], { botId: "B_TEST" }, self), false);
	assert.equal(slackBotAllowed(true, { botId: "B_TEST" }, self), true);
	assert.equal(slackBotAllowed(["B_OTHER"], { botId: "B_TEST" }, self), false);
	assert.equal(slackBotAllowed(["B_TEST"], { botId: "B_TEST" }, self), true);
	assert.equal(slackBotAllowed(["A_TEST"], { appId: "A_TEST" }, self), true);
	assert.equal(slackBotAllowed(["U_TEST"], { userId: "U_TEST" }, self), true);
});

test("Slack bot allowlist fails closed when the current Slack bot identity is unavailable", () => {
	assert.equal(slackBotAllowed(true, { botId: "B_TEST" }, {}), false);
	assert.equal(slackBotAllowed(["B_TEST"], { botId: "B_TEST" }, undefined), false);
});

test("Slack bot allowlist always rejects the current Slack bot identity", () => {
	const self = { botId: "B_SELF", appId: "A_SELF", userId: "U_SELF" };
	assert.equal(slackBotAllowed(true, { botId: "B_SELF" }, self), false);
	assert.equal(slackBotAllowed(["A_SELF"], { appId: "A_SELF" }, self), false);
	assert.equal(slackBotAllowed(["U_SELF"], { userId: "U_SELF" }, self), false);
});

test("Slack bot actor allow is separate from human users and groups", () => {
	assert.deepEqual(
		slackAllowed(
			{ channels: ["C1"], users: ["U_HUMAN"], bots: true },
			{
				channel: "C1",
				user: "U_BOT",
				bot: { botId: "B_TEST", userId: "U_BOT" },
				botSelf: { botId: "B_SELF" },
				isDm: false,
			},
		),
		{ ok: true },
	);
	assert.deepEqual(
		slackAllowed(
			{ channels: ["C1"], users: ["U_HUMAN"] },
			{
				channel: "C1",
				user: "U_BOT",
				bot: { botId: "B_TEST", userId: "U_BOT" },
				botSelf: { botId: "B_SELF" },
				isDm: false,
			},
		),
		{ ok: false, reason: "actor_not_allowed" },
	);
	assert.deepEqual(slackAllowed({ channels: ["C1"], bots: true }, { channel: "C1", user: "U_HUMAN", isDm: false }), {
		ok: true,
	});
});

test("Slack HTTP mode requires a signing secret at runtime", () => {
	assert.throws(
		() =>
			slack({
				botToken: "bot-token",
				mode: "http",
				signingSecret: "",
			}),
		/Slack HTTP mode requires signingSecret/,
	);
	assert.equal(slack({ botToken: "bot-token", mode: "socket", appToken: "app-token" }).name, "slack");
});

test("Slack approval resolution preserves approval card blocks", () => {
	const approval = {
		id: "approval-1",
		callId: "call-1",
		command: "curl --version",
		runtime: "just-bash",
		reason: "Run bash command.",
		allowed: [],
		requestedBy: "U_REQUESTER",
		details: [{ label: "Command", value: "curl --version", format: "code" as const }],
	};
	const pending = approvalBlocks(approval);
	const rejected = approvalBlocks(approval, "rejected", "U_REVIEWER");

	assert.ok(pending);
	assert.ok(rejected);
	assert.match(JSON.stringify(pending[0]), /Approval required/);
	assert.match(JSON.stringify(pending), /Approval ID.*approval-1/);
	assert.match(JSON.stringify(rejected[0]), /Rejected/);
	assert.equal(rejected.at(-1)?.type, "section");
	assert.deepEqual(rejected.slice(1, -1), pending.slice(1, -1));
	assert.match(JSON.stringify(rejected.at(-1)), /Requested by\* <@U_REQUESTER>\\n\*Rejected by\* <@U_REVIEWER>/);
});

test("Telegram allowlists default to accepting delivered message events", () => {
	assert.deepEqual(telegramAllowed(undefined, { chat: "-1001", user: "42", isDm: false }), { ok: true });
	assert.deepEqual(telegramAllowed(undefined, { chat: "42", user: "42", isDm: true }), { ok: true });
});

test("Telegram allowlists reject mismatched dimensions and disabled DMs", () => {
	assert.deepEqual(telegramAllowed({ chats: [-1002] }, { chat: "-1001", user: "42", isDm: false }), {
		ok: false,
		reason: "chat_not_allowed",
	});
	assert.deepEqual(telegramAllowed({ users: [43] }, { chat: "-1001", user: "42", isDm: false }), {
		ok: false,
		reason: "user_not_allowed",
	});
	assert.deepEqual(telegramAllowed({ dms: false }, { chat: "42", user: "42", isDm: true }), {
		ok: false,
		reason: "dm_not_allowed",
	});
	assert.deepEqual(telegramAllowed({ chats: [-1001], dms: true }, { chat: "42", user: "42", isDm: true }), {
		ok: true,
	});
});

test("Telegram bot allowlist defaults closed, supports explicit bots, and rejects self", () => {
	assert.equal(telegramBotAllowed(undefined, 43, 42), false);
	assert.equal(telegramBotAllowed([], 43, 42), false);
	assert.equal(telegramBotAllowed(true, 43, 42), true);
	assert.equal(telegramBotAllowed([44], 43, 42), false);
	assert.equal(telegramBotAllowed([43], 43, 42), true);
	assert.equal(telegramBotAllowed(true, 42, 42), false);
	assert.equal(telegramBotAllowed(true, 43, undefined), false);
});

test("Telegram bot actor allow is separate from users", () => {
	assert.deepEqual(
		telegramAllowed(
			{ chats: [-1001], users: [42], bots: true },
			{ chat: "-1001", user: "43", bot: "43", botSelf: 42, isDm: false },
		),
		{ ok: true },
	);
	assert.deepEqual(
		telegramAllowed(
			{ chats: [-1001], users: [42] },
			{ chat: "-1001", user: "43", bot: "43", botSelf: 42, isDm: false },
		),
		{ ok: false, reason: "user_not_allowed" },
	);
	assert.deepEqual(telegramAllowed({ chats: [-1001], bots: true }, { chat: "-1001", user: "43", isDm: false }), {
		ok: true,
	});
});

test("Telegram trigger defaults to mention for groups and message for DMs", () => {
	assert.deepEqual(telegramTriggered(undefined, { text: "hello", isDm: false, botUsername: "my_bot" }), {
		ok: false,
		reason: "mention_required",
	});
	assert.deepEqual(telegramTriggered(undefined, { text: "hello @my_bot", isDm: false, botUsername: "my_bot" }), {
		ok: true,
	});
	assert.deepEqual(telegramTriggered(undefined, { text: "/deny A1", isDm: false, botUsername: "my_bot" }), {
		ok: true,
	});
	assert.deepEqual(telegramTriggered("message", { text: "hello", isDm: false, botUsername: "my_bot" }), { ok: true });
	assert.deepEqual(telegramTriggered(undefined, { text: "hello", isDm: true, botUsername: "my_bot" }), { ok: true });
	assert.deepEqual(
		telegramTriggered(undefined, { text: "follow up", isDm: false, botUsername: "my_bot", thread: true }),
		{
			ok: true,
		},
	);
	assert.deepEqual(
		telegramTriggered(undefined, {
			text: "follow up",
			isDm: false,
			botUsername: "my_bot",
			thread: true,
			threadTrigger: "mention",
		}),
		{
			ok: false,
			reason: "mention_required",
		},
	);
});

test("Discord allowlists default to accepting delivered messages", () => {
	assert.deepEqual(discordAllowed(undefined, { channel: "C1", user: "U1", isDm: false }), { ok: true });
	assert.deepEqual(discordAllowed(undefined, { channel: "D1", user: "U1", isDm: true }), { ok: true });
});

test("Discord allowlists reject mismatched dimensions and disabled DMs", () => {
	assert.deepEqual(discordAllowed({ channels: ["C2"] }, { channel: "C1", user: "U1", isDm: false }), {
		ok: false,
		reason: "channel not allowed",
	});
	assert.deepEqual(discordAllowed({ users: ["U2"] }, { channel: "C1", user: "U1", isDm: false }), {
		ok: false,
		reason: "actor not allowed",
	});
	assert.deepEqual(discordAllowed({ groups: ["R1"] }, { channel: "C1", user: "U1", groups: ["R1"], isDm: false }), {
		ok: true,
	});
	assert.deepEqual(
		discordAllowed({ users: ["U2"], groups: ["R1"] }, { channel: "C1", user: "U1", groups: ["R1"], isDm: false }),
		{
			ok: true,
		},
	);
	assert.deepEqual(discordAllowed({ dms: false }, { channel: "D1", user: "U1", isDm: true }), {
		ok: false,
		reason: "dm disabled",
	});
	assert.deepEqual(discordAllowed({ channels: ["C1"], dms: true }, { channel: "D1", user: "U1", isDm: true }), {
		ok: true,
	});
});

test("Discord bot allowlist defaults closed, supports explicit bots, and rejects self", () => {
	assert.equal(discordBotAllowed(undefined, "B_TEST", "B_SELF"), false);
	assert.equal(discordBotAllowed([], "B_TEST", "B_SELF"), false);
	assert.equal(discordBotAllowed(true, "B_TEST", "B_SELF"), true);
	assert.equal(discordBotAllowed(["B_OTHER"], "B_TEST", "B_SELF"), false);
	assert.equal(discordBotAllowed(["B_TEST"], "B_TEST", "B_SELF"), true);
	assert.equal(discordBotAllowed(true, "B_SELF", "B_SELF"), false);
	assert.equal(discordBotAllowed(true, "B_TEST", undefined), false);
});

test("Discord bot actor allow is separate from users and groups", () => {
	assert.deepEqual(
		discordAllowed(
			{ channels: ["C1"], users: ["U_HUMAN"], bots: true },
			{ channel: "C1", user: "B_TEST", bot: "B_TEST", botSelf: "B_SELF", isDm: false },
		),
		{ ok: true },
	);
	assert.deepEqual(
		discordAllowed(
			{ channels: ["C1"], users: ["U_HUMAN"] },
			{ channel: "C1", user: "B_TEST", bot: "B_TEST", botSelf: "B_SELF", isDm: false },
		),
		{ ok: false, reason: "actor not allowed" },
	);
	assert.deepEqual(discordAllowed({ channels: ["C1"], bots: true }, { channel: "C1", user: "U_HUMAN", isDm: false }), {
		ok: true,
	});
});

test("Discord trigger defaults to mention for channels and message for DMs", () => {
	assert.deepEqual(discordTriggered(undefined, { text: "hello", isDm: false, mentioned: false }), {
		ok: false,
		reason: "mention required",
	});
	assert.deepEqual(discordTriggered(undefined, { text: "hello", isDm: false, mentioned: true }), { ok: true });
	assert.deepEqual(discordTriggered(undefined, { text: "/status", isDm: false, mentioned: false }), { ok: true });
	assert.deepEqual(discordTriggered("message", { text: "hello", isDm: false, mentioned: false }), { ok: true });
	assert.deepEqual(discordTriggered(undefined, { text: "hello", isDm: true, mentioned: false }), { ok: true });
	assert.deepEqual(discordTriggered(undefined, { text: "follow up", isDm: false, mentioned: false, thread: true }), {
		ok: true,
	});
	assert.deepEqual(
		discordTriggered(undefined, {
			text: "follow up",
			isDm: false,
			mentioned: false,
			thread: true,
			threadTrigger: "mention",
		}),
		{
			ok: false,
			reason: "mention required",
		},
	);
});

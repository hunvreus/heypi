import assert from "node:assert/strict";
import { test } from "node:test";
import { slackAllowed, slackTriggered } from "../src/io/slack.js";
import { telegramAllowed, telegramTriggered } from "../src/io/telegram.js";

test("Slack allowlists default to accepting delivered message events", () => {
	assert.deepEqual(slackAllowed(undefined, { team: "T1", channel: "C1", user: "U1", isDm: false }), { ok: true });
	assert.deepEqual(slackAllowed(undefined, { team: "T1", channel: "C1", user: undefined, isDm: false }), {
		ok: true,
	});
	assert.deepEqual(slackAllowed(undefined, { team: "T1", channel: "D1", user: "U1", isDm: true }), { ok: true });
});

test("Slack allowlists reject mismatched dimensions and disabled DMs", () => {
	assert.deepEqual(slackAllowed({ teams: ["T2"] }, { team: "T1", channel: "C1", user: "U1", isDm: false }), {
		ok: false,
		reason: "team_not_allowed",
	});
	assert.deepEqual(slackAllowed({ channels: ["C2"] }, { team: "T1", channel: "C1", user: "U1", isDm: false }), {
		ok: false,
		reason: "channel_not_allowed",
	});
	assert.deepEqual(slackAllowed({ users: ["U2"] }, { team: "T1", channel: "C1", user: "U1", isDm: false }), {
		ok: false,
		reason: "user_not_allowed",
	});
	assert.deepEqual(slackAllowed({ dms: false }, { team: "T1", channel: "D1", user: "U1", isDm: true }), {
		ok: false,
		reason: "dm_not_allowed",
	});
	assert.deepEqual(
		slackAllowed({ channels: ["C1"], dms: true }, { team: "T1", channel: "D1", user: "U1", isDm: true }),
		{
			ok: true,
		},
	);
});

test("Slack trigger defaults to mention for channels and message for DMs", () => {
	assert.deepEqual(slackTriggered(undefined, { text: "hello", isDm: false, botUserId: "UBOT" }), {
		ok: false,
		reason: "mention_required",
	});
	assert.deepEqual(slackTriggered(undefined, { text: "hello <@UBOT>", isDm: false, botUserId: "UBOT" }), { ok: true });
	assert.deepEqual(slackTriggered("message", { text: "hello", isDm: false, botUserId: "UBOT" }), { ok: true });
	assert.deepEqual(slackTriggered(undefined, { text: "hello", isDm: true, botUserId: "UBOT" }), { ok: true });
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

test("Telegram trigger defaults to mention for groups and message for DMs", () => {
	assert.deepEqual(telegramTriggered(undefined, { text: "hello", isDm: false, botUsername: "my_bot" }), {
		ok: false,
		reason: "mention_required",
	});
	assert.deepEqual(telegramTriggered(undefined, { text: "hello @my_bot", isDm: false, botUsername: "my_bot" }), {
		ok: true,
	});
	assert.deepEqual(telegramTriggered("message", { text: "hello", isDm: false, botUsername: "my_bot" }), { ok: true });
	assert.deepEqual(telegramTriggered(undefined, { text: "hello", isDm: true, botUsername: "my_bot" }), { ok: true });
});

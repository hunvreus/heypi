import assert from "node:assert/strict";
import { test } from "node:test";
import { discordAllowed, discordTriggered } from "../src/io/discord.js";
import { approvalBlocks, slack, slackAllowed, slackMessageSubtypeAllowed, slackTriggered } from "../src/io/slack.js";
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
	assert.deepEqual(slackTriggered(undefined, { text: "approve A1", isDm: false, botUserId: "UBOT" }), { ok: true });
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
	assert.equal(slackMessageSubtypeAllowed("bot_message"), false);
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

test("Slack approval resolution preserves approval blocks and replaces actions", () => {
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
	assert.match(JSON.stringify(rejected[0]), /Rejected/);
	assert.equal(pending.at(-1)?.type, "actions");
	assert.equal(rejected.at(-1)?.type, "context");
	assert.deepEqual(rejected.slice(1, -1), pending.slice(1, -1));
	assert.match(JSON.stringify(rejected.at(-1)), /Rejected by <@U_REVIEWER>/);
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
	assert.deepEqual(telegramTriggered(undefined, { text: "deny A1", isDm: false, botUsername: "my_bot" }), {
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
	assert.deepEqual(discordAllowed(undefined, { guild: "G1", channel: "C1", user: "U1", isDm: false }), { ok: true });
	assert.deepEqual(discordAllowed(undefined, { channel: "D1", user: "U1", isDm: true }), { ok: true });
});

test("Discord allowlists reject mismatched dimensions and disabled DMs", () => {
	assert.deepEqual(discordAllowed({ guilds: ["G2"] }, { guild: "G1", channel: "C1", user: "U1", isDm: false }), {
		ok: false,
		reason: "guild not allowed",
	});
	assert.deepEqual(discordAllowed({ channels: ["C2"] }, { guild: "G1", channel: "C1", user: "U1", isDm: false }), {
		ok: false,
		reason: "channel not allowed",
	});
	assert.deepEqual(discordAllowed({ users: ["U2"] }, { guild: "G1", channel: "C1", user: "U1", isDm: false }), {
		ok: false,
		reason: "user not allowed",
	});
	assert.deepEqual(discordAllowed({ dms: false }, { channel: "D1", user: "U1", isDm: true }), {
		ok: false,
		reason: "dm disabled",
	});
});

test("Discord trigger defaults to mention for channels and message for DMs", () => {
	assert.deepEqual(discordTriggered(undefined, { text: "hello", isDm: false, mentioned: false }), {
		ok: false,
		reason: "mention required",
	});
	assert.deepEqual(discordTriggered(undefined, { text: "hello", isDm: false, mentioned: true }), { ok: true });
	assert.deepEqual(discordTriggered(undefined, { text: "status", isDm: false, mentioned: false }), { ok: true });
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

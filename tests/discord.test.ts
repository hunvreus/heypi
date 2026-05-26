import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeApprovalDetails } from "../src/core/approval-view.js";
import { approvalView, assertDiscordAttachmentUrl, discordAllowed, discordTriggered } from "../src/io/discord.js";

test("Discord allowlists default to accepting delivered messages", () => {
	assert.deepEqual(discordAllowed(undefined, { guild: "G1", channel: "C1", user: "U1", isDm: false }), { ok: true });
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
	assert.deepEqual(discordTriggered(undefined, { text: "approve A1", isDm: false, mentioned: false }), { ok: true });
	assert.deepEqual(discordTriggered(undefined, { text: "hello", isDm: true, mentioned: false }), { ok: true });
	assert.deepEqual(discordTriggered("message", { text: "hello", isDm: false, mentioned: false }), { ok: true });
});

test("Discord attachment URLs are limited to Discord CDN hosts", () => {
	assert.doesNotThrow(() => assertDiscordAttachmentUrl("https://cdn.discordapp.com/attachments/1/2/file.txt"));
	assert.doesNotThrow(() => assertDiscordAttachmentUrl("https://media.discordapp.net/attachments/1/2/file.png"));
	assert.throws(() => assertDiscordAttachmentUrl("http://cdn.discordapp.com/attachments/1/2/file.txt"), /protocol/);
	assert.throws(() => assertDiscordAttachmentUrl("https://example.com/attachments/1/2/file.txt"), /host/);
});

test("Discord approval view presents pending and rejected states as card data", () => {
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

	assert.deepEqual(approvalView({ approval, state: "pending" }), {
		title: "Approval required",
		color: 0xf59e0b,
		fields: [
			{ name: "Reason", value: "Run bash command." },
			{ name: "Command", value: "```\ncurl --version\n```" },
			{ name: "Requested by", value: "<@U_REQUESTER>" },
		],
	});

	const rejected = approvalView({ approval, state: "rejected", actor: "U1" });
	assert.equal(rejected.title, "Rejected");
	assert.equal(rejected.color, 0xf59e0b);
	assert.deepEqual(rejected.fields.at(-1), {
		name: "Rejected by",
		value: "<@U1>",
	});
});

test("Discord approval view truncates long code details inside a valid code fence", () => {
	const view = approvalView({
		state: "pending",
		approval: {
			id: "approval-1",
			callId: "call-1",
			command: "bash",
			runtime: "tool",
			reason: "Run command.",
			allowed: [],
			details: [{ label: "Command", value: "x".repeat(2000), format: "code" }],
		},
	});

	const command = view.fields.find((field) => field.name === "Command");
	assert.ok(command);
	assert.equal(command.value.startsWith("```\n"), true);
	assert.equal(command.value.endsWith("\n```"), true);
	assert.equal(command.value.length <= 1024, true);
});

test("approval details are capped to stay within Discord embed field limits", () => {
	const details = normalizeApprovalDetails(
		Array.from({ length: 40 }, (_, index) => ({
			label: `Detail ${index + 1}`,
			value: `value ${index + 1}`,
		})),
	);
	const view = approvalView({
		state: "rejected",
		actor: "U_REVIEWER",
		approval: {
			id: "approval-1",
			callId: "call-1",
			command: "tool",
			runtime: "tool",
			reason: "Review details.",
			allowed: [],
			requestedBy: "U_REQUESTER",
			details,
		},
	});

	assert.ok(view.fields.length <= 25);
	assert.deepEqual(view.fields.at(-2), { name: "Requested by", value: "<@U_REQUESTER>" });
	assert.deepEqual(view.fields.at(-3), { name: "Additional details", value: "20 omitted." });
});

import { describe, expect, it } from "vitest";
import { discordApprovalPayload, discordMessage } from "../src/discord.js";

describe("discordMessage", () => {
	it("normalizes mentioned guild messages", () => {
		expect(
			discordMessage(
				{
					id: "m1",
					channelId: "c1",
					content: "hey <@bot>",
					author: { id: "u1", username: "Ronan" },
					guildId: "g1",
					mentions: { has: (id) => id === "bot" },
					attachments: [{ id: "a1", name: "a.txt", url: "https://cdn/a.txt", contentType: "text/plain" }],
				},
				"bot",
			),
		).toEqual({
			id: "m1",
			adapter: "discord",
			account: "discord",
			conversation: "c1",
			user: { id: "u1", name: "Ronan", isBot: false },
			text: "hey <@bot>",
			mentioned: true,
			dm: false,
			attachments: [{ id: "a1", name: "a.txt", url: "https://cdn/a.txt", mime: "text/plain" }],
		});
	});

	it("treats messages without guilds as DMs", () => {
		expect(
			discordMessage({
				id: "m1",
				channelId: "d1",
				content: "hello",
				author: { id: "u1" },
				guildId: null,
			}).dm,
		).toBe(true);
	});

	it("renders approval buttons", () => {
		expect(
			discordApprovalPayload({
				id: "abc",
				reason: "Run bash tool.",
				command: "git push",
				requestedBy: "@Ronan",
			}),
		).toEqual({
			content: [
				"*Approval required*",
				"- Reason: Run bash tool.",
				"- Command:\n```\ngit push\n```",
				"- Requested by: @Ronan",
			].join("\n"),
			components: [
				{
					type: 1,
					components: [
						{ type: 2, style: 3, label: "Approve", custom_id: "heypi_approve:abc", disabled: false },
						{ type: 2, style: 4, label: "Reject", custom_id: "heypi_reject:abc", disabled: false },
					],
				},
			],
		});
	});

	it("disables resolved approval buttons", () => {
		const payload = discordApprovalPayload({
			id: "abc",
			reason: "Run bash tool.",
			state: "approved",
			resolvedBy: "@Ronan",
		});
		expect(payload.components[0].components.map((button) => button.disabled)).toEqual([true, true]);
		expect(payload.content).toContain("- Approved by: @Ronan");
	});
});

import { describe, expect, it } from "vitest";
import { discordMessage } from "../src/discord.js";

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
});

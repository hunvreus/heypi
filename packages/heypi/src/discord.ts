import { Client, GatewayIntentBits, Partials } from "discord.js";
import type { Adapter, ChatMessage } from "./types.js";

export type DiscordConfig = {
	name?: string;
	token: string;
	clientId?: string;
};

export type DiscordMessageInput = {
	id: string;
	channelId: string;
	content: string;
	author: {
		id: string;
		username?: string;
		bot?: boolean;
	};
	guildId?: string | null;
	mentions?: {
		has(userId: string): boolean;
	};
	attachments?: Array<{ id: string; name?: string; url: string; contentType?: string | null }>;
};

export function discordMessage(message: DiscordMessageInput, botUserId?: string): ChatMessage {
	return {
		id: message.id,
		adapter: "discord",
		account: "discord",
		conversation: message.channelId,
		user: {
			id: message.author.id,
			name: message.author.username,
			isBot: message.author.bot === true,
		},
		text: message.content,
		mentioned: botUserId ? (message.mentions?.has(botUserId) ?? false) : false,
		dm: !message.guildId,
		attachments: message.attachments?.map((attachment) => ({
			id: attachment.id,
			name: attachment.name,
			url: attachment.url,
			mime: attachment.contentType ?? undefined,
		})),
	};
}

export function discord(config: DiscordConfig): Adapter {
	let client: Client | undefined;
	return {
		kind: "discord",
		name: config.name,
		async start(context) {
			client = new Client({
				intents: [
					GatewayIntentBits.DirectMessages,
					GatewayIntentBits.GuildMessages,
					GatewayIntentBits.Guilds,
					GatewayIntentBits.MessageContent,
				],
				partials: [Partials.Channel],
			});
			client.on("messageCreate", async (message) => {
				if (message.author.bot) return;
				const botUserId = client?.user?.id ?? config.clientId;
				const normalized = discordMessage(
					{
						id: message.id,
						channelId: message.channelId,
						content: message.content,
						author: { id: message.author.id, username: message.author.username, bot: message.author.bot },
						guildId: message.guildId,
						mentions: { has: (userId) => message.mentions.users.has(userId) },
						attachments: [...message.attachments.values()].map((attachment) => ({
							id: attachment.id,
							name: attachment.name,
							url: attachment.url,
							contentType: attachment.contentType,
						})),
					},
					botUserId,
				);
				if (!normalized.dm && !normalized.mentioned) return;
				await context.receive(normalized);
			});
			await client.login(config.token);
			context.logger.info("adapter.discord.start");
		},
		async stop() {
			await client?.destroy();
			client = undefined;
		},
		async send(message) {
			if (!client) throw new Error("Discord adapter is not started");
			const channel = await client.channels.fetch(message.conversation);
			if (!channel || !("send" in channel) || typeof channel.send !== "function") {
				throw new Error(`Discord channel cannot receive messages: ${message.conversation}`);
			}
			const result = await channel.send({ content: message.text });
			return { id: result.id };
		},
	};
}

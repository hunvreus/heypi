import { once } from "node:events";
import { ChannelType, Client, GatewayIntentBits, type Message, Partials } from "discord.js";

export type DiscordIdentity = {
	id: string;
	username: string;
	name?: string;
};

export type DiscordObserved = {
	guild?: string;
	guildName?: string;
	channel: string;
	channelName?: string;
	user: string;
	userName?: string;
	dm: boolean;
};

export type DiscordChannel = {
	guild: string;
	guildName: string;
	channel: string;
	channelName: string;
};

/** Validates a Discord bot token and returns the bot identity. */
export async function discordCheck(token: string): Promise<DiscordIdentity> {
	return withDiscordClient(token, [GatewayIntentBits.Guilds], async (client) => ({
		id: client.user.id,
		username: client.user.username,
		name: client.user.globalName ?? undefined,
	}));
}

/** Lists text channels visible to the bot. */
export async function discordChannels(token: string): Promise<DiscordChannel[]> {
	return withDiscordClient(token, [GatewayIntentBits.Guilds], async (client) => {
		const out: DiscordChannel[] = [];
		for (const guildRef of client.guilds.cache.values()) {
			const guild = await guildRef.fetch();
			const channels = await guild.channels.fetch();
			for (const channel of channels.values()) {
				if (!channel) continue;
				if (channel.type !== ChannelType.GuildText && channel.type !== ChannelType.GuildAnnouncement) continue;
				out.push({
					guild: guild.id,
					guildName: guild.name,
					channel: channel.id,
					channelName: channel.name,
				});
			}
		}
		return out.sort((a, b) => a.guildName.localeCompare(b.guildName) || a.channelName.localeCompare(b.channelName));
	});
}

/** Observes the next delivered Discord message and returns provider IDs. */
export async function discordObserve(token: string, timeoutSeconds: number): Promise<DiscordObserved> {
	return withDiscordClient(
		token,
		[
			GatewayIntentBits.Guilds,
			GatewayIntentBits.GuildMessages,
			GatewayIntentBits.DirectMessages,
			GatewayIntentBits.MessageContent,
		],
		async (client) =>
			await new Promise<DiscordObserved>((resolve, reject) => {
				const timer = setTimeout(() => {
					client.off("messageCreate", onMessage);
					reject(new Error("Timed out waiting for Discord message"));
				}, timeoutSeconds * 1000);
				const onMessage = (message: Message) => {
					if (message.author.bot) return;
					clearTimeout(timer);
					client.off("messageCreate", onMessage);
					resolve(observed(message));
				};
				client.on("messageCreate", onMessage);
			}),
	);
}

export function discordInviteUrl(clientId: string): string {
	const permissions = "274878008384";
	return `https://discord.com/oauth2/authorize?client_id=${encodeURIComponent(clientId)}&scope=bot%20applications.commands&permissions=${permissions}`;
}

async function withDiscordClient<T>(
	token: string,
	intents: GatewayIntentBits[],
	work: (client: Client<true>) => Promise<T>,
): Promise<T> {
	const client = new Client({ intents, partials: [Partials.Channel, Partials.Message] });
	try {
		const ready = once(client, "ready");
		await client.login(token);
		if (!client.isReady()) {
			await Promise.race([
				ready,
				new Promise((_, reject) =>
					setTimeout(() => reject(new Error("Discord client failed to become ready")), 10_000),
				),
			]);
		}
		if (!client.isReady()) throw new Error("Discord client failed to become ready");
		return await work(client);
	} finally {
		client.destroy();
	}
}

function observed(message: Message): DiscordObserved {
	return {
		guild: message.guildId ?? undefined,
		guildName: message.guild?.name,
		channel: message.channelId,
		channelName: "name" in message.channel ? (message.channel.name ?? undefined) : undefined,
		user: message.author.id,
		userName: message.author.username,
		dm: message.channel.type === ChannelType.DM,
	};
}

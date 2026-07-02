import { Client, GatewayIntentBits, Partials } from "discord.js";
import { approvalRows, approvalTitle, renderApprovalMessage } from "./approval.js";
import type { Adapter, ApprovalDecision, ApprovalView, ChatMessage } from "./types.js";

const APPROVE = "heypi_approve";
const REJECT = "heypi_reject";

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

type PendingApproval = {
	view: ApprovalView;
	resolve(decision: ApprovalDecision): void;
};

export type DiscordApprovalPayload = {
	content: string;
	embeds?: Array<{
		title: string;
		color: number;
		fields: Array<{ name: string; value: string; inline?: boolean }>;
	}>;
	components: Array<{
		type: 1;
		components: Array<{
			type: 2;
			style: 3 | 4;
			label: string;
			custom_id: string;
			disabled?: boolean;
		}>;
	}>;
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

export function discordApprovalPayload(view: ApprovalView): DiscordApprovalPayload {
	const disabled = view.state === "approved" || view.state === "rejected";
	const components = [
		{
			type: 1 as const,
			components: [
				{
					type: 2 as const,
					style: 3 as const,
					label: "Approve",
					custom_id: `${APPROVE}:${view.id}`,
					disabled,
				},
				{
					type: 2 as const,
					style: 4 as const,
					label: "Reject",
					custom_id: `${REJECT}:${view.id}`,
					disabled,
				},
			],
		},
	];
	if (view.layout === "card") {
		return {
			content: "",
			embeds: [discordApprovalEmbed(view)],
			components,
		};
	}
	return {
		content: renderApprovalMessage(view),
		components,
	};
}

function discordApprovalEmbed(view: ApprovalView): NonNullable<DiscordApprovalPayload["embeds"]>[number] {
	return {
		title: approvalTitle(view.state),
		color: approvalColor(view.state),
		fields: approvalRows(view).map((row) => ({
			name: row.label.slice(0, 256),
			value: (row.format === "code" ? `\`\`\`\n${row.value}\n\`\`\`` : row.value).slice(0, 1024),
		})),
	};
}

function approvalColor(state?: ApprovalView["state"]): number {
	if (state === "approved") return 0x2eb67d;
	if (state === "rejected") return 0xe01e5a;
	return 0xecb22e;
}

export function discord(config: DiscordConfig): Adapter {
	let client: Client | undefined;
	const pending = new Map<string, PendingApproval>();
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
			client.on("interactionCreate", async (interaction) => {
				if (!interaction.isButton()) return;
				const [action, id] = interaction.customId.split(":");
				const approval = id ? pending.get(id) : undefined;
				if (!approval || (action !== APPROVE && action !== REJECT)) return;
				pending.delete(id);
				const resolvedBy = `<@${interaction.user.id}>`;
				const approved = action === APPROVE;
				await interaction.update(
					discordApprovalPayload({
						...approval.view,
						state: approved ? "approved" : "rejected",
						resolvedBy,
					}),
				);
				approval.resolve({
					approved,
					resolvedBy,
					reason: approved ? undefined : "Rejected in Discord.",
				});
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
		async requestApproval(view) {
			if (!client) return { approved: false, reason: "Discord adapter is not started." };
			if (!view.conversation) return { approved: false, reason: "Discord approval has no target conversation." };
			const channel = await client.channels.fetch(view.conversation);
			if (!channel || !("send" in channel) || typeof channel.send !== "function") {
				return { approved: false, reason: `Discord channel cannot receive approvals: ${view.conversation}` };
			}
			await channel.send(discordApprovalPayload(view));
			return new Promise<ApprovalDecision>((resolve) => {
				pending.set(view.id, { view, resolve });
			});
		},
	};
}

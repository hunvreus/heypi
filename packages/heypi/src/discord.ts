import { Client, GatewayIntentBits, Partials } from "discord.js";
import { approvalActorAllowed, approvalRows, approvalTitle, renderApprovalMessage } from "./approval.js";
import { materializeAttachments as materializeAdapterAttachments } from "./attachments.js";
import {
	type AdapterEvent,
	type AdapterEventHandler,
	type AdapterEvents,
	type AdapterEventType,
	busyEvents,
} from "./events.js";
import { chunkText, formatOutgoingText, splitLocalAttachments } from "./message.js";
import type {
	Adapter,
	AdapterApprovalConfig,
	AllowConfig,
	ApprovalDecision,
	ApprovalView,
	ApproverSet,
	BusyMode,
	ChatMessage,
} from "./types.js";

const APPROVE = "heypi_approve";
const REJECT = "heypi_reject";
const DISCORD_TEXT_LIMIT = 2_000;

export type DiscordConfig = {
	id?: string;
	token: string;
	clientId?: string;
	allow?: AllowConfig;
	admins?: ApproverSet;
	approvers?: ApproverSet;
	approvals?: AdapterApprovalConfig;
	busy?: BusyMode;
	typing?: boolean;
	events?: AdapterEvents;
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
	message?: { edit(payload: unknown): Promise<unknown> };
	timer?: ReturnType<typeof setTimeout>;
	resolve(decision: ApprovalDecision): void;
};

type TypingControls = {
	start(message: ChatMessage): void;
	stop(message: ChatMessage): void;
	stopAll(): void;
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

export function discordMessage(message: DiscordMessageInput, botUserId?: string, adapterId = "discord"): ChatMessage {
	const isSelf = Boolean(botUserId && message.author.id === botUserId);
	return {
		id: message.id,
		adapter: "discord",
		adapterId,
		conversation: message.channelId,
		user: {
			id: message.author.id,
			name: message.author.username,
			isBot: message.author.bot === true,
			...(isSelf ? { isSelf: true } : {}),
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

function memberRoles(member: unknown): string[] {
	if (!member || typeof member !== "object" || !("roles" in member)) return [];
	const roles = (member as { roles?: unknown }).roles;
	if (!roles || typeof roles !== "object" || !("cache" in roles)) return [];
	const cache = (roles as { cache?: unknown }).cache;
	if (!cache || typeof cache !== "object" || !("keys" in cache)) return [];
	const keys = (cache as { keys?: unknown }).keys;
	if (typeof keys !== "function") return [];
	return [...(keys.call(cache) as Iterable<string>)];
}

function typingKey(message: ChatMessage): string {
	return `${message.conversation}:${message.thread ?? ""}`;
}

function createTypingControls(getClient: () => Client | undefined): TypingControls {
	const timers = new Map<string, ReturnType<typeof setInterval>>();

	async function sendTyping(message: ChatMessage): Promise<void> {
		const client = getClient();
		if (!client) return;
		const channel = await client.channels.fetch(message.conversation);
		if (channel && "sendTyping" in channel && typeof channel.sendTyping === "function") {
			await channel.sendTyping();
		}
	}

	return {
		start(message) {
			const key = typingKey(message);
			if (timers.has(key)) return;
			void sendTyping(message);
			timers.set(
				key,
				setInterval(() => {
					void sendTyping(message);
				}, 5000),
			);
		},
		stop(message) {
			const key = typingKey(message);
			const timer = timers.get(key);
			if (!timer) return;
			clearInterval(timer);
			timers.delete(key);
		},
		stopAll() {
			for (const timer of timers.values()) clearInterval(timer);
			timers.clear();
		},
	};
}

function withTypingEvents(events: AdapterEvents | undefined, typing: TypingControls): AdapterEvents {
	function wrap<T extends AdapterEventType>(
		type: T,
		native: AdapterEventHandler<Extract<AdapterEvent, { type: T }>>,
	): AdapterEventHandler<Extract<AdapterEvent, { type: T }>> | false {
		const user = events?.[type] as AdapterEventHandler<Extract<AdapterEvent, { type: T }>> | false | undefined;
		if (user === false) return false;
		return async (event, context) => {
			await native(event, context);
			await user?.(event, context);
		};
	}

	return {
		...busyEvents(),
		...events,
		"message.accepted": wrap("message.accepted", (_event, context) => typing.start(context.message)),
		"turn.started": wrap("turn.started", (_event, context) => typing.start(context.message)),
		"message.completed": wrap("message.completed", (_event, context) => typing.stop(context.message)),
		"turn.failed": wrap("turn.failed", (_event, context) => typing.stop(context.message)),
		"turn.canceled": wrap("turn.canceled", (_event, context) => typing.stop(context.message)),
	};
}

function typingEvents(enabled: boolean | undefined, events: AdapterEvents | undefined, typing: TypingControls) {
	if (enabled === false) return { ...busyEvents(), ...(events ?? {}) };
	return withTypingEvents(events, typing);
}

export function discord(config: DiscordConfig): Adapter {
	let client: Client | undefined;
	const pending = new Map<string, PendingApproval>();
	const typing = createTypingControls(() => client);
	const adapterId = config.id ?? "discord";
	return {
		kind: "discord",
		id: adapterId,
		allow: config.allow,
		admins: config.admins,
		approvers: config.approvers,
		approvals: config.approvals,
		busy: config.busy ?? "queue",
		events: typingEvents(config.typing, config.events, typing),
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
					adapterId,
				);
				if (normalized.user.isSelf) return;
				if (!normalized.dm && !normalized.mentioned) return;
				await context.receive(normalized);
			});
			client.on("interactionCreate", async (interaction) => {
				if (!interaction.isButton()) return;
				const [action, id] = interaction.customId.split(":");
				const approval = id ? pending.get(id) : undefined;
				if (!approval || (action !== APPROVE && action !== REJECT)) return;
				const resolvedBy = `<@${interaction.user.id}>`;
				const approved = action === APPROVE;
				const roles = memberRoles(interaction.member);
				if (
					!approvalActorAllowed(
						{ approved, resolvedBy, resolvedById: interaction.user.id, roles },
						config.approvers,
						config.admins,
					)
				)
					return;
				pending.delete(id);
				if (approval.timer) clearTimeout(approval.timer);
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
					resolvedById: interaction.user.id,
					roles,
					reason: approved ? undefined : "Rejected in Discord.",
				});
			});
			await client.login(config.token);
			context.logger.info("adapter.discord.start");
		},
		async stop() {
			typing.stopAll();
			await client?.destroy();
			client = undefined;
		},
		async materializeAttachments(message, target) {
			return {
				...message,
				attachments: await materializeAdapterAttachments(message.attachments, {
					dir: target.dir,
					displayDir: target.displayDir,
				}),
			};
		},
		async send(message) {
			if (!client) throw new Error("Discord adapter is not started");
			const channel = await client.channels.fetch(message.conversation);
			if (!channel || !("send" in channel) || typeof channel.send !== "function") {
				throw new Error(`Discord channel cannot receive messages: ${message.conversation}`);
			}
			const { local, references } = splitLocalAttachments(message.attachments);
			const chunks = chunkText(formatOutgoingText(message.text, references), DISCORD_TEXT_LIMIT);
			let firstId: string | undefined;
			for (const [index, content] of chunks.entries()) {
				const result = await channel.send({
					content,
					files:
						index === chunks.length - 1
							? local.map((attachment) => ({
									attachment: attachment.localPath ?? "",
									name: attachment.name,
								}))
							: undefined,
				});
				firstId ??= result.id;
			}
			return { id: firstId };
		},
		async update(message) {
			if (!client) throw new Error("Discord adapter is not started");
			const channel = await client.channels.fetch(message.conversation);
			if (!channel || !("messages" in channel)) return;
			const messages = channel.messages;
			if (
				!messages ||
				typeof messages !== "object" ||
				!("fetch" in messages) ||
				typeof messages.fetch !== "function"
			) {
				return;
			}
			const target = await messages.fetch(message.id);
			if (target && "edit" in target && typeof target.edit === "function") {
				await target.edit({ content: formatOutgoingText(message.text, message.attachments) });
			}
		},
		async requestApproval(view) {
			if (!client) return { approved: false, reason: "Discord adapter is not started." };
			if (!view.conversation) return { approved: false, reason: "Discord approval has no target conversation." };
			const channel = await client.channels.fetch(view.conversation);
			if (!channel || !("send" in channel) || typeof channel.send !== "function") {
				return { approved: false, reason: `Discord channel cannot receive approvals: ${view.conversation}` };
			}
			const sent = (await channel.send(discordApprovalPayload(view))) as {
				edit(payload: unknown): Promise<unknown>;
			};
			return new Promise<ApprovalDecision>((resolve) => {
				const pendingApproval: PendingApproval = { view, message: sent, resolve };
				const timeoutMs = config.approvals?.timeoutMs;
				if (timeoutMs && timeoutMs > 0) {
					pendingApproval.timer = setTimeout(() => {
						if (!pending.delete(view.id)) return;
						void sent
							.edit(discordApprovalPayload({ ...view, state: "rejected", resolvedBy: "timeout" }))
							.catch(() => undefined);
						resolve({ approved: false, reason: "Approval expired." });
					}, timeoutMs);
				}
				pending.set(view.id, pendingApproval);
			});
		},
	};
}

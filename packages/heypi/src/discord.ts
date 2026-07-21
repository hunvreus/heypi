import { Client, GatewayIntentBits, Partials } from "discord.js";
import {
	approvalActorAllowed,
	approvalRows,
	approvalTitle,
	renderApprovalMessage,
	settleApproval,
} from "./approval.js";
import { materializeAttachments as materializeAdapterAttachments } from "./attachments.js";
import type { AdapterEvents } from "./events.js";
import { chunkText, formatOutgoingText, splitLocalAttachments } from "./message.js";
import type {
	Adapter,
	AdapterApprovalConfig,
	AdapterContext,
	AllowConfig,
	ApprovalDecision,
	ApprovalView,
	ApproverSet,
	AttachmentPolicy,
	BusyMode,
	ChatMessage,
} from "./types.js";
import { createTypingControls, typingEvents } from "./typing.js";

const APPROVE = "heypi_approve";
const REJECT = "heypi_reject";
const APPROVAL_CANCELED = "Approval canceled.";
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
	attachments?: AttachmentPolicy;
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
	parentChannelId?: string | null;
	replyTo?: string;
	mentions?: {
		has(userId: string): boolean;
	};
	attachments?: Array<{ id: string; name?: string; url: string; contentType?: string | null }>;
};

type PendingApproval = {
	view: ApprovalView;
	message?: { id: string; edit(payload: unknown): Promise<unknown> };
	timer?: ReturnType<typeof setTimeout>;
	cancel(): void;
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

export function discordMessage(message: DiscordMessageInput, botUserId?: string, adapterId = "discord"): ChatMessage {
	const isSelf = Boolean(botUserId && message.author.id === botUserId);
	return {
		id: message.id,
		adapter: "discord",
		adapterId,
		conversation: message.channelId,
		...(!message.guildId ? {} : { channel: message.parentChannelId ?? message.channelId }),
		...(message.replyTo ? { replyTo: message.replyTo } : {}),
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

export function discord(config: DiscordConfig): Adapter {
	let client: Client | undefined;
	let context: AdapterContext | undefined;
	const pending = new Map<string, PendingApproval>();
	const typing = createTypingControls(
		5000,
		async (message) => {
			const channel = await client?.channels.fetch(message.conversation);
			if (channel && "sendTyping" in channel && typeof channel.sendTyping === "function") await channel.sendTyping();
		},
		(error) => {
			context?.logger.warn("adapter_discord_typing_failed", {
				message: error instanceof Error ? error.message : String(error),
			});
		},
	);
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
		async start(nextContext) {
			context = nextContext;
			client = new Client({
				intents: [
					GatewayIntentBits.DirectMessages,
					GatewayIntentBits.GuildMessages,
					GatewayIntentBits.Guilds,
					GatewayIntentBits.MessageContent,
				],
				partials: [Partials.Channel],
			});
			const reportError = (error: unknown) => {
				nextContext.logger.error("adapter_discord_error", {
					message: error instanceof Error ? error.message : String(error),
				});
			};
			client.on("error", reportError);
			client.on("messageCreate", (message) => {
				void (async () => {
					const botUserId = client?.user?.id ?? config.clientId;
					const normalized = discordMessage(
						{
							id: message.id,
							channelId: message.channelId,
							content: message.content,
							author: { id: message.author.id, username: message.author.username, bot: message.author.bot },
							guildId: message.guildId,
							parentChannelId: message.channel.isThread() ? message.channel.parentId : undefined,
							replyTo: message.reference?.messageId,
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
					if (!normalized.dm && !normalized.mentioned && !normalized.replyTo) return;
					await (nextContext.enqueue ?? nextContext.receive)(normalized);
				})().catch(reportError);
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
				await settleApproval({
					claim: () => pending.delete(id),
					timer: approval.timer,
					update: () =>
						interaction.update(
							discordApprovalPayload({
								...approval.view,
								state: approved ? "approved" : "rejected",
								resolvedBy,
							}),
						),
					updateFailed: (error) =>
						nextContext.logger.warn("adapter_discord_approval_update_failed", {
							message: error instanceof Error ? error.message : String(error),
						}),
					resolve: () =>
						approval.resolve({
							approved,
							messageIds: approval.message ? [approval.message.id] : undefined,
							resolvedBy,
							resolvedById: interaction.user.id,
							roles,
							reason: approved ? undefined : "Rejected in Discord.",
						}),
				});
			});
			await client.login(config.token);
			nextContext.logger.info("adapter_discord_started");
		},
		async stop() {
			for (const approval of [...pending.values()]) approval.cancel();
			typing.stopAll();
			await client?.destroy();
			client = undefined;
		},
		async materializeAttachments(message, target) {
			const policy = config.attachments;
			return {
				...message,
				attachments: await materializeAdapterAttachments(message.attachments, {
					dir: target.dir,
					displayDir: target.displayDir,
					maxBytes: policy?.maxBytes,
					timeoutMs: policy?.timeoutMs,
					mimeTypes: policy?.mimeTypes,
					hosts: policy?.hosts ?? ["*.discordapp.com", "*.discordapp.net"],
					retry: policy?.retry,
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
			const ids: string[] = [];
			for (const [index, content] of chunks.entries()) {
				const result = await channel.send({
					content,
					reply:
						index === 0 && message.replyTo
							? { messageReference: message.replyTo, failIfNotExists: false }
							: undefined,
					allowedMentions: { repliedUser: false },
					files:
						index === chunks.length - 1
							? local.map((attachment) => ({
									attachment: attachment.localPath ?? "",
									name: attachment.name,
								}))
							: undefined,
				});
				ids.push(result.id);
			}
			return { id: ids[0], ids };
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
		async requestApproval(view, signal) {
			if (!client) return { approved: false, reason: "Discord adapter is not started." };
			if (!view.conversation) return { approved: false, reason: "Discord approval has no target conversation." };
			const channel = await client.channels.fetch(view.conversation);
			if (!channel || !("send" in channel) || typeof channel.send !== "function") {
				return { approved: false, reason: `Discord channel cannot receive approvals: ${view.conversation}` };
			}
			const sent = (await channel.send({
				...discordApprovalPayload(view),
				reply: view.replyTo ? { messageReference: view.replyTo, failIfNotExists: false } : undefined,
				allowedMentions: { repliedUser: false },
			})) as {
				id: string;
				edit(payload: unknown): Promise<unknown>;
			};
			return new Promise<ApprovalDecision>((resolve) => {
				const cleanup = () => signal?.removeEventListener("abort", cancel);
				const cancel = () => {
					if (!pending.delete(view.id)) return;
					if (pendingApproval.timer) clearTimeout(pendingApproval.timer);
					pendingApproval.resolve({ approved: false, messageIds: [sent.id], reason: APPROVAL_CANCELED });
					void sent
						.edit(discordApprovalPayload({ ...view, state: "rejected", resolvedBy: "canceled" }))
						.catch(() => undefined);
				};
				const pendingApproval: PendingApproval = {
					view,
					message: sent,
					cancel,
					resolve(decision) {
						cleanup();
						resolve(decision);
					},
				};
				const timeoutMs = config.approvals?.timeoutMs;
				if (timeoutMs && timeoutMs > 0) {
					pendingApproval.timer = setTimeout(() => {
						if (!pending.delete(view.id)) return;
						void sent
							.edit(discordApprovalPayload({ ...view, state: "rejected", resolvedBy: "timeout" }))
							.catch(() => undefined);
						pendingApproval.resolve({
							approved: false,
							messageIds: [sent.id],
							reason: "Approval expired.",
						});
					}, timeoutMs);
				}
				pending.set(view.id, pendingApproval);
				signal?.addEventListener("abort", cancel, { once: true });
				if (signal?.aborted) cancel();
			});
		},
	};
}

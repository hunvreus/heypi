import {
	ActionRowBuilder,
	AttachmentBuilder,
	ButtonBuilder,
	ButtonStyle,
	ChannelType,
	Client,
	EmbedBuilder,
	Events,
	GatewayIntentBits,
	type Interaction,
	type Message,
	Partials,
	type TextBasedChannel,
} from "discord.js";
import { approvalStateTitle, codeFence } from "../core/approval-view.js";
import { message as errorMessage, type Logger, userError } from "../core/log.js";
import type { ScopedKey } from "../core/scope.js";
import type { ApprovalResolution } from "../core/types.js";
import { chunkText } from "../render/chunk.js";
import { resolveOutboundAttachments, saveInboundAttachments } from "./attachment-policy.js";
import { type Attachment, type AttachmentStore, responseBytes } from "./attachments.js";
import { runChatMessage } from "./chat-message.js";
import { type DeliveryConfig, DeliveryQueue } from "./delivery.js";
import { allowByDimensions, messageTriggered } from "./gate.js";
import type { Adapter, AdapterStart, AdapterTarget, Outbound } from "./handler.js";
import { logCtx } from "./log-context.js";
import { DraftReplyStream, type ReplyStreamOption } from "./reply-stream.js";

const APPROVE = "heypi_approve";
const DENY = "heypi_deny";
const DISCORD_TEXT_LIMIT = 2000;
const DISCORD_EMBED_FIELD_LIMIT = 1024;
const APPROVAL_PENDING_COLOR = 0xf59e0b;

export type DiscordConfig = {
	name?: string;
	token: string;
	allow?: DiscordAllow;
	trigger?: DiscordTrigger;
	threadTrigger?: DiscordTrigger | false;
	progress?: DiscordProgress | false;
	streaming?: ReplyStreamOption;
	delivery?: DeliveryConfig | false;
};

export type DiscordTrigger = "mention" | "message";

export type DiscordAllow = {
	guilds?: string[];
	channels?: string[];
	users?: string[];
	dms?: boolean;
};

export type DiscordProgress = {
	message?: string | false;
	delayMs?: number;
};

/** Creates a Discord gateway adapter. Requires Message Content Intent for non-mention message text. */
export function discord(input: DiscordConfig): Adapter {
	const name = input.name ?? "discord";
	const kind = "discord";
	const client = new Client({
		intents: [
			GatewayIntentBits.Guilds,
			GatewayIntentBits.GuildMessages,
			GatewayIntentBits.DirectMessages,
			GatewayIntentBits.MessageContent,
		],
		partials: [Partials.Channel, Partials.Message],
	});
	let activeLogger: Logger | undefined;
	let delivery = new DeliveryQueue(input.delivery);

	return {
		name,
		kind,
		async start(start: AdapterStart): Promise<void> {
			activeLogger = start.logger;
			delivery = new DeliveryQueue(input.delivery, start.logger);
			start.logger.info("adapter.start", { adapter: name, kind });
			client.on(Events.MessageCreate, (msg) => {
				void handleMessage({ client, start, config: input, delivery, provider: name, kind, msg });
			});
			client.on(Events.InteractionCreate, (interaction) => {
				void handleInteraction({ start, delivery, provider: name, kind, interaction });
			});
			await client.login(input.token);
		},
		async stop(): Promise<void> {
			client.removeAllListeners();
			client.destroy();
			activeLogger?.info("adapter.stop", { adapter: name, kind });
		},
		async send(target: AdapterTarget, out: Outbound, start?: AdapterStart): Promise<void> {
			const log = start?.logger ?? activeLogger;
			const channel = await discordTargetChannel(client, target);
			await sendDiscordOutput({
				channel,
				store: start?.attachments,
				out,
				logger: log ?? noopLogger,
				context: { adapter: name, kind, channel: target.channel, user: target.user },
				delivery,
			});
			log?.debug("adapter.send", {
				adapter: name,
				kind,
				channel: target.channel,
				user: target.user,
				chars: out.text.length,
			});
		},
	};
}

async function handleMessage(input: {
	client: Client;
	start: AdapterStart;
	config: DiscordConfig;
	delivery: DeliveryQueue;
	provider: string;
	kind: string;
	msg: Message;
}): Promise<void> {
	const msg = input.msg;
	if (msg.author.bot || !msg.channel) return;
	const channel = msg.channelId;
	const actor = msg.author.id;
	const team = msg.guildId ?? undefined;
	const trace = `discord:${msg.id}`;
	const dm = isDm(msg);
	const context = (extra?: Record<string, unknown>) =>
		logCtx({ trace, adapter: input.provider, kind: input.kind, channel }, extra);
	const allow = discordAllowed(input.config.allow, { guild: team, channel, user: actor, isDm: dm });
	if (!allow.ok) {
		input.start.logger.debug(
			"adapter.drop",
			context({
				actor,
				reason: allow.reason,
			}),
		);
		return;
	}
	const trigger = discordTriggered(input.config.trigger, {
		text: msg.content,
		isDm: dm,
		mentioned: input.client.user ? msg.mentions.has(input.client.user) : false,
		thread: discordThread(msg),
		threadTrigger: input.config.threadTrigger,
	});
	if (!trigger.ok) {
		input.start.logger.debug(
			"adapter.drop",
			context({
				actor,
				reason: trigger.reason,
			}),
		);
		return;
	}
	const streaming = streamingEnabled(input.config.streaming);
	const progress = discordProgress(input.config.progress, streaming);
	const stream = discordReplyStream({
		config: input.config.streaming,
		message: msg,
		logger: input.start.logger,
		context: context(),
		delivery: input.delivery,
	});
	const pending = startDiscordProgress({
		message: msg,
		progress,
		cancelId: trace,
		logger: input.start.logger,
		context: context(),
		delivery: input.delivery,
	});
	await runChatMessage({
		logger: input.start.logger,
		context,
		handler: input.start.handler,
		stream,
		progress: pending,
		loadAttachments: (scope) =>
			discordAttachments({
				store: input.start.attachments,
				scope,
				message: msg,
				trace,
				provider: input.provider,
				kind: input.kind,
				logger: input.start.logger,
			}),
		inbound: () => ({
			trace,
			provider: input.provider,
			kind: input.kind,
			eventId: msg.id,
			team,
			channel,
			channelName: discordChannelName(msg.channel),
			actor,
			actorName: msg.author.username,
			thread: threadKey(msg),
			threadName: discordThreadName(msg.channel),
			text: msg.content,
			data: {
				guildId: msg.guildId,
				channelId: msg.channelId,
				messageId: msg.id,
				attachments: msg.attachments.map((item) => ({ id: item.id, name: item.name, size: item.size })),
			},
		}),
		placement: {
			fresh: async (out) => {
				const target = out.private ? await msg.author.createDM() : msg.channel;
				await sendDiscordOutput({
					channel: target,
					store: input.start.attachments,
					out,
					replyTo: out.private ? undefined : msg,
					skipFirst: false,
					logger: input.start.logger,
					context: context(),
					delivery: input.delivery,
				});
			},
			streamed: async (out) => {
				await uploadDiscordAttachments({
					channel: msg.channel,
					store: input.start.attachments,
					attachments: out.attachments,
					scope: out.attachmentScope,
					logger: input.start.logger,
					context: context(),
					delivery: input.delivery,
				});
			},
			progress: async (out) => {
				const edited = await pending.update(out);
				const target = out.private ? await msg.author.createDM() : msg.channel;
				await sendDiscordOutput({
					channel: target,
					store: input.start.attachments,
					out,
					replyTo: out.private ? undefined : msg,
					skipFirst: edited,
					logger: input.start.logger,
					context: context(),
					delivery: input.delivery,
				});
			},
		},
		sendError: async () => {
			const text = userError(input.start.messages?.error);
			const edited = await pending.update({ text });
			await sendTextChunks({
				channel: msg.channel,
				text,
				replyTo: msg,
				skipFirst: edited,
				context: context(),
				delivery: input.delivery,
			});
		},
	});
}

async function handleInteraction(input: {
	start: AdapterStart;
	delivery: DeliveryQueue;
	provider: string;
	kind: string;
	interaction: Interaction;
}): Promise<void> {
	if (!input.interaction.isButton()) return;
	const interaction = input.interaction;
	const action = parseAction(interaction.customId);
	if (!action) return;
	const trace = `discord:${interaction.id}`;
	const channel = interaction.channelId ?? "unknown";
	const team = interaction.guildId ?? undefined;
	const actor = interaction.user.id;
	const context = (extra?: Record<string, unknown>) =>
		logCtx({ trace, adapter: input.provider, kind: input.kind, channel }, extra);
	let acknowledged = false;
	const acknowledge = async (out: Outbound) => {
		const embed = approvalEmbedForAction(out, out.approvalResolution ?? "approved", actor, interaction.message);
		if (!embed) throw new Error("Discord approval acknowledgement missing approval embed");
		await interaction.editReply({
			content: "",
			embeds: [embed],
			components: [],
		});
		acknowledged = true;
	};
	const replace = async (out: Outbound) => {
		const embed = approvalEmbedForAction(
			out,
			out.approvalResolution ?? actionResolution(action.kind),
			actor,
			interaction.message,
		);
		if (!embed) throw new Error("Discord approval replacement missing approval embed");
		await interaction.editReply({
			content: "",
			embeds: [embed],
			components: [],
		});
	};
	await interaction.deferUpdate();
	try {
		const out = await input.start.handler({
			trace,
			provider: input.provider,
			kind: input.kind,
			eventId: interaction.id,
			team,
			channel,
			actor,
			thread: channel,
			text: `${action.kind} ${action.id}`,
			data: { customId: interaction.customId, messageId: interaction.message.id },
			ack: action.kind === "approve" ? (out) => acknowledge(out) : undefined,
			replace: action.kind === "approve" || action.kind === "deny" ? replace : undefined,
		});
		if (!out) return;
		if (out.private) {
			if (out.replaceOriginal) {
				const embed = approvalEmbedForAction(out, out.approvalResolution, actor, interaction.message);
				if (embed) {
					await interaction.editReply({
						content: "",
						embeds: [embed],
						components: [],
					});
					return;
				}
			}
			await interaction.followUp({ content: out.text, ephemeral: true }).catch(() => undefined);
			return;
		}
		const target = interaction.channel;
		if (!target) return;
		if (acknowledged) {
			await sendDiscordOutput({
				channel: target,
				store: input.start.attachments,
				out,
				logger: input.start.logger,
				context: context(),
				delivery: input.delivery,
			});
			return;
		}
		if (action.kind === "deny" && !out.private) {
			const embed = approvalEmbedForAction(out, out.approvalResolution ?? "rejected", actor, interaction.message);
			if (!embed) throw new Error("Discord approval rejection missing approval embed");
			await interaction.editReply({
				content: "",
				embeds: [embed],
				components: [],
			});
			return;
		}
		const rendered = out.private ? out : { ...out, text: approvedFallbackText(actor, out.text, action.id) };
		if (!out.private) {
			await interaction.editReply({
				content: "",
				embeds: rendered.approval ? [approvalEmbed(rendered.approval, "pending")] : [],
				components: rendered.approval ? approvalComponents(rendered.approval) : [],
			});
			await sendDiscordOutput({
				channel: target,
				store: input.start.attachments,
				out: rendered,
				skipFirst: true,
				logger: input.start.logger,
				context: context(),
				delivery: input.delivery,
			});
			return;
		}
		await sendDiscordOutput({
			channel: target,
			store: input.start.attachments,
			out: rendered,
			logger: input.start.logger,
			context: context(),
			delivery: input.delivery,
		});
	} catch (error) {
		input.start.logger.error(
			"adapter.error",
			context({
				error: errorMessage(error),
			}),
		);
		await interaction
			.followUp({ content: userError(input.start.messages?.error), ephemeral: true })
			.catch(() => undefined);
	}
}

async function discordTargetChannel(client: Client, target: AdapterTarget): Promise<TextBasedChannel> {
	if (target.channel) {
		const channel = await client.channels.fetch(target.channel);
		if (!channel?.isTextBased()) throw new Error(`Discord channel is not text-capable: ${target.channel}`);
		return channel;
	}
	if (!target.user) throw new Error("Discord scheduled target requires channel or user");
	const user = await client.users.fetch(target.user);
	return user.createDM();
}

async function sendDiscordOutput(input: {
	channel: TextBasedChannel;
	store?: AttachmentStore;
	out: Outbound;
	replyTo?: Message;
	skipFirst?: boolean;
	logger: Logger;
	context: Record<string, unknown>;
	delivery: DeliveryQueue;
}): Promise<void> {
	await sendTextChunks({
		channel: input.channel,
		text: input.out.text,
		approval: input.out.approval,
		replyTo: input.replyTo,
		skipFirst: input.skipFirst,
		context: input.context,
		delivery: input.delivery,
	});
	await uploadDiscordAttachments({
		channel: input.channel,
		store: input.store,
		attachments: input.out.attachments,
		scope: input.out.attachmentScope,
		logger: input.logger,
		context: input.context,
		delivery: input.delivery,
	});
}

async function sendTextChunks(input: {
	channel: TextBasedChannel;
	text: string;
	approval?: Outbound["approval"];
	replyTo?: Message;
	skipFirst?: boolean;
	context: Record<string, unknown>;
	delivery: DeliveryQueue;
}): Promise<void> {
	if (input.approval && !input.skipFirst) {
		const approval = input.approval;
		await input.delivery.run(
			() =>
				sendTo(input.channel, input.replyTo, {
					embeds: [approvalEmbed(approval, "pending")],
					components: approvalComponents(approval),
				}),
			{ ...input.context, retry: "send" },
		);
		return;
	}
	const chunks = chunkText(discordMarkdown(input.text), DISCORD_TEXT_LIMIT);
	for (let index = input.skipFirst ? 1 : 0; index < chunks.length; index++) {
		await input.delivery.run(
			() =>
				sendTo(input.channel, input.replyTo, {
					content: chunks[index],
				}),
			{ ...input.context, retry: "send" },
		);
	}
}

function discordReplyStream(input: {
	config?: ReplyStreamOption;
	message: Message;
	logger: Logger;
	context: Record<string, unknown>;
	delivery: DeliveryQueue;
}) {
	if (!input.config || (typeof input.config === "object" && input.config.enabled === false)) return undefined;
	return new DraftReplyStream(
		{
			limit: DISCORD_TEXT_LIMIT,
			create: async (text) => {
				const sent = await input.delivery.run(() => input.message.reply({ content: text }), {
					...input.context,
					retry: "send",
				});
				return sent.id;
			},
			edit: async (id, text) => {
				const sent = await input.message.channel.messages.fetch(id);
				await input.delivery.run(() => sent.edit({ content: text }), input.context);
			},
			delete: async (id) => {
				const sent = await input.message.channel.messages.fetch(id);
				await input.delivery.run(() => sent.delete(), input.context);
			},
		},
		input.config,
		input.logger,
		input.context,
	);
}

export function startDiscordProgress(input: {
	message: Message;
	progress?: DiscordProgress;
	cancelId?: string;
	logger: Logger;
	context: Record<string, unknown>;
	delivery: DeliveryQueue;
}) {
	let id: string | undefined;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let send: Promise<void> | undefined;
	const text = input.progress?.message === false ? undefined : (input.progress?.message ?? "Working...");
	if (text) {
		timer = setTimeout(() => {
			send = input.delivery
				.run(() => input.message.reply({ content: text }), { ...input.context, retry: "send" })
				.then((msg) => {
					id = msg.id;
				})
				.catch((error) =>
					input.logger.warn("discord.progress.message_failed", { ...input.context, error: errorMessage(error) }),
				);
		}, input.progress?.delayMs ?? 1000);
	}
	return {
		async update(out: Outbound): Promise<boolean> {
			await send;
			if (!id) return false;
			const messageId = id;
			try {
				const msg = await input.message.channel.messages.fetch(messageId);
				await input.delivery.run(
					() =>
						msg.edit({
							content: out.approval ? "" : firstChunk(out.text),
							embeds: out.approval ? [approvalEmbed(out.approval, "pending")] : [],
							components: out.approval ? approvalComponents(out.approval) : [],
						}),
					input.context,
				);
				id = undefined;
				return true;
			} catch (error) {
				input.logger.warn("discord.progress.update_failed", { ...input.context, error: errorMessage(error) });
				return false;
			}
		},
		async stop(): Promise<void> {
			if (timer) clearTimeout(timer);
			await send;
			if (!id) return;
			const messageId = id;
			id = undefined;
			try {
				const msg = await input.message.channel.messages.fetch(messageId);
				await input.delivery.run(() => msg.delete(), input.context);
			} catch {
				// Progress deletion is best effort.
			}
		},
	};
}

async function discordAttachments(input: {
	store?: AttachmentStore;
	scope?: ScopedKey;
	message: Message;
	trace: string;
	provider: string;
	kind: string;
	logger: Logger;
}): Promise<Attachment[] | undefined> {
	const maxBytes = input.store?.maxBytes;
	return await saveInboundAttachments({
		provider: input.provider,
		kind: input.kind,
		store: input.store,
		scope: input.scope,
		messageId: input.message.id,
		trace: input.trace,
		logItemField: "attachment",
		logger: input.logger,
		refs: input.message.attachments.map((item) => ({
			id: item.id,
			name: item.name,
			mimeType: item.contentType ?? undefined,
			size: item.size,
			sourceUrl: item.url,
		})),
		download: async (item) => {
			if (!item.sourceUrl) throw new Error("Discord attachment URL missing");
			assertDiscordAttachmentUrl(item.sourceUrl);
			const response = await fetch(item.sourceUrl);
			if (!response.ok) throw new Error(`Discord attachment download failed: ${response.status}`);
			return await responseBytes(response, maxBytes);
		},
	});
}

export function assertDiscordAttachmentUrl(input: string): void {
	let url: URL;
	try {
		url = new URL(input);
	} catch {
		throw new Error("invalid Discord attachment URL");
	}
	if (url.protocol !== "https:") throw new Error("invalid Discord attachment URL protocol");
	if (url.hostname !== "cdn.discordapp.com" && url.hostname !== "media.discordapp.net") {
		throw new Error("invalid Discord attachment URL host");
	}
}

async function uploadDiscordAttachments(input: {
	channel: TextBasedChannel;
	store?: AttachmentStore;
	attachments?: Array<{ path: string; name?: string; mimeType?: string }>;
	scope?: ScopedKey;
	logger: Logger;
	context: Record<string, unknown>;
	delivery: DeliveryQueue;
}): Promise<void> {
	if (!input.attachments?.length) return;
	const resolved = await resolveOutboundAttachments({
		provider: "discord",
		store: input.store,
		attachments: input.attachments,
		scope: input.scope,
		logger: input.logger,
		context: input.context,
	});
	const files = resolved.map((file) => new AttachmentBuilder(file.path, { name: file.name }));
	if (!files.length) return;
	await input.delivery.run(() => sendTo(input.channel, undefined, { files }), { ...input.context, retry: "send" });
}

function approvalComponents(approval: NonNullable<Outbound["approval"]>) {
	return [
		new ActionRowBuilder<ButtonBuilder>().addComponents(
			new ButtonBuilder().setCustomId(`${APPROVE}:${approval.id}`).setLabel("Approve").setStyle(ButtonStyle.Success),
			new ButtonBuilder().setCustomId(`${DENY}:${approval.id}`).setLabel("Reject").setStyle(ButtonStyle.Danger),
		),
	];
}

type ApprovalViewState = "pending" | "approved" | "rejected" | "expired";

export function approvalView(input: { approval?: Outbound["approval"]; state: ApprovalViewState; actor?: string }): {
	title: string;
	color: number;
	fields: Array<{ name: string; value: string; inline?: boolean }>;
} {
	const fields: Array<{ name: string; value: string; inline?: boolean }> = [];
	if (input.approval?.reason) fields.push({ name: "Reason", value: truncateEmbedValue(input.approval.reason) });
	for (const detail of input.approval?.details ?? []) {
		fields.push({
			name: truncateEmbedValue(detail.label, 256),
			value: detail.format === "code" ? codeValue(detail.value) : truncateEmbedValue(detail.value),
		});
	}
	if (input.approval?.requestedBy) fields.push({ name: "Requested by", value: `<@${input.approval.requestedBy}>` });
	const resolution = approvalResolutionField(input.state, input.actor);
	if (resolution) fields.push(resolution);
	return { title: approvalTitle(input.state), color: APPROVAL_PENDING_COLOR, fields };
}

function approvalEmbed(approval: Outbound["approval"] | undefined, state: ApprovalViewState, actor?: string) {
	const view = approvalView({ approval, state, actor });
	return new EmbedBuilder().setTitle(view.title).setColor(view.color).addFields(view.fields);
}

function approvalEmbedForAction(
	out: Outbound,
	state: Outbound["approvalResolution"],
	actor: string,
	source: Message,
): EmbedBuilder | undefined {
	if (out.approval && state) return approvalEmbed(out.approval, state, actor);
	const embed = source.embeds[0];
	if (!embed || embed.fields.length >= 25) return undefined;
	return EmbedBuilder.from(embed).addFields({
		name: "Status",
		value: truncateEmbedValue(out.text),
	});
}

function approvalResolutionField(
	state: ApprovalViewState,
	actor?: string,
): { name: string; value: string; inline?: boolean } | undefined {
	if (state === "approved") return { name: "Approved by", value: actor ? `<@${actor}>` : approvalStateTitle(state) };
	if (state === "rejected") return { name: "Rejected by", value: actor ? `<@${actor}>` : approvalStateTitle(state) };
	if (state === "expired") return { name: "Status", value: approvalStateTitle(state) };
	return undefined;
}

function actionResolution(kind: "approve" | "deny"): ApprovalResolution {
	return kind === "approve" ? "approved" : "rejected";
}

function parseAction(input: string): { kind: "approve" | "deny"; id: string } | undefined {
	const [kind, id] = input.split(":");
	if (kind === APPROVE && id) return { kind: "approve", id };
	if (kind === DENY && id) return { kind: "deny", id };
	return undefined;
}

function approvedFallbackText(actor: string, text: string, id?: string): string {
	const prefix = id ? `Approval \`${id}\` approved by <@${actor}>.` : `Approved by <@${actor}>.`;
	return [prefix, text].filter(Boolean).join("\n\n");
}

function approvalTitle(state: ApprovalViewState): string {
	return approvalStateTitle(state === "pending" ? undefined : state);
}

function codeValue(value: string): string {
	const truncated = truncateEmbedValue(value, DISCORD_EMBED_FIELD_LIMIT - 10);
	return codeFence(truncated);
}

function truncateEmbedValue(value: string, limit = DISCORD_EMBED_FIELD_LIMIT): string {
	if (value.length <= limit) return value;
	return `${value.slice(0, Math.max(0, limit - 1))}…`;
}

function firstChunk(text: string): string {
	return chunkText(discordMarkdown(text), DISCORD_TEXT_LIMIT)[0] ?? "";
}

function discordMarkdown(text: string): string {
	return text.replace(/^\*Approval required\*/m, "**Approval required**");
}

function sendTo(
	channel: TextBasedChannel,
	replyTo: Message | undefined,
	input: Parameters<Message["reply"]>[0],
): Promise<Message> {
	if (replyTo) return replyTo.reply(input);
	if (!("send" in channel) || typeof channel.send !== "function") {
		throw new Error("Discord channel cannot send messages");
	}
	return channel.send(input);
}

function threadKey(msg: Message): string {
	return msg.channelId;
}

function discordChannelName(channel: TextBasedChannel): string | undefined {
	return "name" in channel && typeof channel.name === "string" ? channel.name : undefined;
}

function discordThreadName(channel: TextBasedChannel): string | undefined {
	return typeof channel.isThread === "function" && channel.isThread() ? discordChannelName(channel) : undefined;
}

function isDm(msg: Message): boolean {
	return msg.channel.type === ChannelType.DM;
}

function discordThread(msg: Message): boolean {
	const channel = msg.channel as { isThread?: () => boolean };
	return typeof channel.isThread === "function" && channel.isThread();
}

function streamingEnabled(input?: ReplyStreamOption): boolean {
	return Boolean(input && (input === true || typeof input !== "object" || input.enabled !== false));
}

function discordProgress(input: DiscordConfig["progress"], streaming: boolean): DiscordProgress | undefined {
	if (input === false || streaming) return undefined;
	return input ?? { delayMs: 0 };
}

export function discordAllowed(
	input: DiscordAllow | undefined,
	event: { guild?: string; channel: string; user: string; isDm: boolean },
): { ok: true } | { ok: false; reason: string } {
	return allowByDimensions({
		dms: input?.dms,
		isDm: event.isDm,
		dmReason: "dm disabled",
		dimensions: [
			{ allowlist: input?.guilds, value: event.guild, reason: "guild not allowed" },
			{ allowlist: input?.channels, value: event.channel, reason: "channel not allowed" },
			{ allowlist: input?.users, value: event.user, reason: "user not allowed" },
		],
	});
}

export function discordTriggered(
	input: DiscordTrigger | undefined,
	event: {
		text?: string;
		isDm: boolean;
		mentioned: boolean;
		thread?: boolean;
		threadTrigger?: DiscordTrigger | false;
	},
): { ok: true } | { ok: false; reason: string } {
	return messageTriggered({
		trigger: input,
		isDm: event.isDm,
		thread: event.thread,
		threadTrigger: event.threadTrigger,
		mentioned: event.mentioned,
		text: event.text,
		reason: "mention required",
	});
}

const noopLogger: Logger = {
	debug() {},
	info() {},
	warn() {},
	error() {},
};

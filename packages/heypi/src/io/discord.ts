import { readFile } from "node:fs/promises";
import {
	ActionRowBuilder,
	AttachmentBuilder,
	ButtonBuilder,
	ButtonStyle,
	ChannelType,
	type ChatInputCommandInteraction,
	Client,
	EmbedBuilder,
	Events,
	GatewayIntentBits,
	type Interaction,
	type Message,
	Partials,
	REST,
	Routes,
	SlashCommandBuilder,
	type TextBasedChannel,
} from "discord.js";
import type { PermissionsConfig } from "../config.js";
import { type ApprovalViewState, approvalViewRows, approvalViewTitle, codeFence } from "../core/approval-view.js";
import { actorGroups as configuredGroups } from "../core/approvers.js";
import { COMMAND_NAMES, COMMANDS } from "../core/commands.js";
import { message as errorMessage, type Logger, userError } from "../core/log.js";
import type { ScopedKey } from "../core/scope.js";
import { chunkText } from "../render/chunk.js";
import { actorAllowedValue, actorAllowlist } from "./actor-allow.js";
import {
	attachmentUploadNoticeText,
	attachmentUploadText,
	resolveOutboundAttachments,
	saveInboundAttachments,
} from "./attachment-policy.js";
import { type Attachment, type AttachmentStore, responseBytes } from "./attachments.js";
import { botAllowConfigured, botIdentityAllowed } from "./bot-allow.js";
import { runChatMessage } from "./chat-message.js";
import { chatAdapterConfigKeys, validateAdapterConfig, warnAdapterConfig } from "./config-validation.js";
import {
	type ControlAction,
	type ControlActionTokens,
	controlActionCallback,
	controlActionLabel,
	controlActionText,
	parseControlAction,
} from "./control-action.js";
import { type DeliveryConfig, DeliveryQueue } from "./delivery.js";
import { optionalEnv, requiredEnv } from "./env.js";
import { allowByDimensions, messageTriggered } from "./gate.js";
import type { Adapter, AdapterStart, AdapterTarget, Outbound } from "./handler.js";
import { logCtx } from "./log-context.js";
import { delayedProgressPlaceholder } from "./progress-placeholder.js";
import { normalizeProgressConfig } from "./progress-config.js";
import { DraftReplyStream, type ReplyStreamOption } from "./reply-stream.js";
import { warnMissingChatAllow } from "./security-warning.js";

const APPROVE = "heypi_approve";
const DENY = "heypi_deny";
const CANCEL = "heypi_cancel";
const STATUS = "heypi_status";
const DISCORD_ACTIONS = {
	approve: APPROVE,
	deny: DENY,
	cancel: CANCEL,
	status: STATUS,
} satisfies ControlActionTokens;
const DISCORD_TEXT_LIMIT = 2000;
const DISCORD_EMBED_FIELD_LIMIT = 1024;
const DISCORD_ATTACHMENT_UPLOAD_TIMEOUT_MS = 15_000;
const APPROVAL_PENDING_COLOR = 0xf59e0b;
const APPROVAL_APPROVED_COLOR = 0x22c55e;
const APPROVAL_REJECTED_COLOR = 0xef4444;
const APPROVAL_EXPIRED_COLOR = 0x64748b;
const DISCORD_CONFIG_KEYS = chatAdapterConfigKeys("token", "clientId", "registerCommands");

export type DiscordConfig = {
	name?: string;
	token?: string;
	clientId?: string;
	registerCommands?: boolean;
	allow?: DiscordAllow;
	permissions?: PermissionsConfig;
	trigger?: DiscordTrigger;
	threadTrigger?: DiscordTrigger | false;
	response?: DiscordResponse;
	progress?: DiscordProgress | false;
	streaming?: ReplyStreamOption;
	delivery?: DeliveryConfig | false;
};

export type DiscordTrigger = "mention" | "message";

export type DiscordResponse = {
	placement?: "auto" | "same" | "reply";
	continueRecentMs?: number | false;
};

export type DiscordAllow = {
	channels?: string[];
	users?: string[];
	groups?: string[];
	bots?: true | string[];
	dms?: boolean;
};

export type DiscordProgress = {
	message?: string | false;
	delayMs?: number;
};

/** Creates a Discord gateway adapter. Requires Message Content Intent for non-mention message text. */
export function discord(config: DiscordConfig = {}): Adapter {
	const input = resolveDiscordConfig(config);
	const name = input.name ?? "discord";
	const configValidation = validateAdapterConfig(name, input, DISCORD_CONFIG_KEYS);
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
		permissions: input.permissions,
		acceptsBots: botAllowConfigured(input.allow?.bots),
		async start(start: AdapterStart): Promise<void> {
			activeLogger = start.logger;
			delivery = new DeliveryQueue(input.delivery, start.logger);
			warnAdapterConfig(start.logger, name, configValidation);
			const groups = new DiscordGroupResolver(
				[
					...(input.allow?.groups ?? []),
					...configuredGroups(start.approval?.approvers),
					...configuredGroups(start.approval?.admins),
				],
				start.logger,
			);
			start.logger.info("adapter.start", { adapter: name, kind });
			if (!discordAllowConfigured(input.allow)) {
				warnMissingChatAllow({ logger: start.logger, adapter: name, kind, surface: "channel" });
			}
			client.on(Events.MessageCreate, (msg) => {
				void handleMessage({ client, start, config: input, delivery, provider: name, kind, groups, msg });
			});
			client.on(Events.InteractionCreate, (interaction) => {
				void handleInteraction({ start, config: input, delivery, provider: name, kind, groups, interaction });
			});
			await client.login(input.token);
			if (input.registerCommands !== false && input.clientId) {
				await registerDiscordCommands(input.token, input.clientId, start.logger);
			}
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
				token: input.token,
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
	groups: DiscordGroupResolver;
	msg: Message;
}): Promise<void> {
	const msg = input.msg;
	if (!msg.channel) return;
	const bot = msg.author.bot ? msg.author.id : undefined;
	const channel = msg.channelId;
	const actor = msg.author.id;
	const team = msg.guildId ?? undefined;
	const trace = `discord:${msg.id}`;
	const dm = isDm(msg);
	const context = (extra?: Record<string, unknown>) =>
		logCtx({ trace, adapter: input.provider, kind: input.kind, channel }, extra);
	if (bot && !discordBotAllowed(input.config.allow?.bots, bot, input.client.user?.id)) {
		input.start.logger.debug("adapter.drop", context({ actor, reason: "bot_not_allowed" }));
		return;
	}
	const actorGroups = bot ? [] : await input.groups.forMessage(msg);
	const allow = discordAllowed(input.config.allow, {
		channel,
		user: actor,
		groups: actorGroups,
		bot,
		botSelf: input.client.user?.id,
		isDm: dm,
	});
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
	const progress = discordProgress(input.config.progress);
	const reply = discordReplyPlacement(input.config.response, msg);
	const thread = await discordThreadKey({
		start: input.start,
		provider: input.provider,
		team,
		channel,
		actor,
		message: msg,
		response: input.config.response,
	});
	const pending = startDiscordProgress({
		message: msg,
		reply,
		progress,
		cancelId: trace,
		logger: input.start.logger,
		context: context(),
		delivery: input.delivery,
	});
	const stream = discordReplyStream({
		config: input.config.streaming,
		message: msg,
		reply,
		logger: input.start.logger,
		context: context(),
		delivery: input.delivery,
		takeoverFirstMessage: () => pending.takeover(),
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
			providerMessageId: msg.id,
			team,
			channel,
			channelName: discordChannelName(msg.channel),
			actor,
			actorGroups,
			actorBot: Boolean(bot),
			actorName: msg.author.username,
			thread,
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
				const ids = await sendDiscordOutput({
					channel: target,
					token: input.config.token,
					store: input.start.attachments,
					out,
					replyTo: !reply || out.private ? undefined : msg,
					skipFirst: false,
					logger: input.start.logger,
					context: context(),
					delivery: input.delivery,
				});
				await indexDiscordProviderMessages({
					start: input.start,
					provider: input.provider,
					team,
					channel,
					thread,
					actor: input.client.user?.id,
					ids,
				});
			},
			streamed: async (out) => {
				const upload = await uploadDiscordAttachments({
					channel: msg.channel,
					token: input.config.token,
					store: input.start.attachments,
					attachments: out.attachments,
					scope: out.attachmentScope,
					logger: input.start.logger,
					context: context(),
					delivery: input.delivery,
				});
				await indexDiscordProviderMessages({
					start: input.start,
					provider: input.provider,
					team,
					channel,
					thread,
					actor: input.client.user?.id,
					ids: [...(stream?.ids?.() ?? []), ...upload.messageIds],
				});
				await postDiscordAttachmentUploadNotice({
					channel: msg.channel,
					upload,
					context: context(),
					delivery: input.delivery,
				});
			},
			progress: async (out) => {
				const edited = await pending.update(out);
				const target = out.private ? await msg.author.createDM() : msg.channel;
				const ids = await sendDiscordOutput({
					channel: target,
					token: input.config.token,
					store: input.start.attachments,
					out,
					replyTo: !reply || out.private ? undefined : msg,
					skipFirst: edited,
					logger: input.start.logger,
					context: context(),
					delivery: input.delivery,
				});
				await indexDiscordProviderMessages({
					start: input.start,
					provider: input.provider,
					team,
					channel,
					thread,
					actor: input.client.user?.id,
					ids,
				});
			},
		},
		sendError: async () => {
			const text = userError(input.start.messages?.error);
			const edited = await pending.update({ text });
			await sendTextChunks({
				channel: msg.channel,
				text,
				replyTo: reply ? msg : undefined,
				skipFirst: edited,
				context: context(),
				delivery: input.delivery,
			});
		},
	});
}

async function handleInteraction(input: {
	start: AdapterStart;
	config: DiscordConfig;
	delivery: DeliveryQueue;
	provider: string;
	kind: string;
	groups: DiscordGroupResolver;
	interaction: Interaction;
}): Promise<void> {
	if (input.interaction.isChatInputCommand()) return handleCommandInteraction(input);
	if (!input.interaction.isButton()) return;
	const interaction = input.interaction;
	const action = parseAction(interaction.customId);
	if (!action) return;
	const trace = `discord:${interaction.id}`;
	const channel = interaction.channelId ?? "unknown";
	const team = interaction.guildId ?? undefined;
	const actor = interaction.user.id;
	const actorGroups = await input.groups.forInteraction(interaction);
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
		const resolution = action.kind === "deny" ? "rejected" : "approved";
		const embed = approvalEmbedForAction(out, out.approvalResolution ?? resolution, actor, interaction.message);
		if (!embed) throw new Error("Discord approval replacement missing approval embed");
		await interaction.editReply({
			content: "",
			embeds: [embed],
			components: [],
		});
	};
	await interaction.deferUpdate();
	const progress =
		action.kind === "approve"
			? startDiscordProgress({
					message: interaction.message,
					reply: !isDm(interaction.message),
					progress: discordProgress(input.config.progress),
					cancelId: trace,
					logger: input.start.logger,
					context: context(),
					delivery: input.delivery,
				})
			: undefined;
	try {
		const out = await input.start.handler({
			trace,
			provider: input.provider,
			kind: input.kind,
			eventId: interaction.id,
			team,
			channel,
			actor,
			actorGroups,
			thread: channel,
			text: discordActionText(action),
			data: { customId: interaction.customId, messageId: interaction.message.id },
			ack: action.kind === "approve" ? (out) => acknowledge(out) : undefined,
			replace: action.kind === "approve" || action.kind === "deny" ? replace : undefined,
			runtimeProgress: progress ? { update: (text) => progress.notify(text) } : undefined,
		});
		if (!out) return;
		if (out.silent) return;
		if (action.kind === "cancel" || action.kind === "status") {
			await interaction.followUp({ content: out.text, ephemeral: true }).catch(() => undefined);
			return;
		}
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
			const edited = progress ? await progress.update(out) : false;
			await sendDiscordOutput({
				channel: target,
				token: input.config.token,
				store: input.start.attachments,
				out,
				skipFirst: edited,
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
				token: input.config.token,
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
			token: input.config.token,
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
	} finally {
		await progress?.stop();
	}
}

async function handleCommandInteraction(input: {
	start: AdapterStart;
	config: DiscordConfig;
	delivery: DeliveryQueue;
	provider: string;
	kind: string;
	groups: DiscordGroupResolver;
	interaction: Interaction;
}): Promise<void> {
	const interaction = input.interaction;
	if (!interaction.isChatInputCommand() || !DISCORD_COMMANDS.has(interaction.commandName)) return;
	const trace = `discord:${interaction.id}`;
	const channel = interaction.channelId ?? "unknown";
	const actor = interaction.user.id;
	const team = interaction.guildId ?? undefined;
	const context = (extra?: Record<string, unknown>) =>
		logCtx({ trace, adapter: input.provider, kind: input.kind, channel }, extra);
	try {
		const actorGroups = await input.groups.forInteraction(interaction);
		const allow = discordAllowed(input.config.allow, {
			channel,
			user: actor,
			groups: actorGroups,
			isDm: !interaction.guildId,
		});
		if (!allow.ok) {
			input.start.logger.debug("adapter.drop", context({ actor, reason: allow.reason }));
			await interaction.reply({ content: "You are not allowed to use heypi here.", ephemeral: true });
			return;
		}
		await interaction.deferReply({ ephemeral: true });
		const text = discordCommandText(interaction);
		const out = await input.start.handler({
			trace,
			provider: input.provider,
			kind: input.kind,
			eventId: interaction.id,
			team,
			channel,
			actor,
			actorGroups,
			thread: channel,
			text,
			data: { command: interaction.commandName },
		});
		if (!out || out.silent) {
			await interaction.deleteReply().catch(() => undefined);
			return;
		}
		if (out.private || !interaction.channel?.isTextBased()) {
			await interaction.editReply({ content: firstChunk(out.text) });
			return;
		}
		await interaction.editReply({ content: "Posted to channel." });
		await sendDiscordOutput({
			channel: interaction.channel,
			token: input.config.token,
			store: input.start.attachments,
			out,
			logger: input.start.logger,
			context: context(),
			delivery: input.delivery,
		});
	} catch (error) {
		input.start.logger.error("adapter.error", context({ error: errorMessage(error) }));
		if (interaction.deferred || interaction.replied) {
			await interaction.editReply({ content: userError(input.start.messages?.error) }).catch(() => undefined);
		} else {
			await interaction
				.reply({ content: userError(input.start.messages?.error), ephemeral: true })
				.catch(() => undefined);
		}
	}
}

function discordCommandText(interaction: ChatInputCommandInteraction): string {
	const command = interaction.commandName;
	if (command === "help") return "/help";
	if (command === "approvals") return "/approvals";
	if (command === "bypasses") return "/bypasses";
	if (command === "approve") {
		const id = interaction.options.getString("id", true);
		const bypass = interaction.options.getBoolean("bypass") ? " bypass" : "";
		return `/approve ${id}${bypass}`;
	}
	if (command === "deny") return `/deny ${interaction.options.getString("id", true)}`;
	if (command === "status") {
		const id = interaction.options.getString("id");
		return id ? `/status ${id}` : "/status";
	}
	if (command === "cancel") return `/cancel ${interaction.options.getString("id", true)}`;
	if (command === "revoke") return `/revoke ${interaction.options.getString("id", true)}`;
	if (command === "bash") return `/bash ${interaction.options.getString("command", true)}`;
	return "/help";
}

async function registerDiscordCommands(token: string, clientId: string, log: Logger): Promise<void> {
	const rest = new REST({ version: "10" }).setToken(token);
	await rest.put(Routes.applicationCommands(clientId), { body: discordCommands().map((command) => command.toJSON()) });
	log.info("discord.commands_registered", { clientId });
}

const DISCORD_COMMANDS: ReadonlySet<string> = COMMAND_NAMES;

function discordCommands() {
	return COMMANDS.map((command) => discordCommand(command.name).setDescription(command.description));
}

function discordCommand(name: string) {
	const command = new SlashCommandBuilder().setName(name);
	if (name === "approve") {
		return command
			.addStringOption((option) => option.setName("id").setDescription("Approval ID").setRequired(true))
			.addBooleanOption((option) =>
				option.setName("bypass").setDescription("Create a temporary bypass after approval"),
			);
	}
	if (name === "deny") {
		return command.addStringOption((option) => option.setName("id").setDescription("Approval ID").setRequired(true));
	}
	if (name === "status") {
		return command.addStringOption((option) => option.setName("id").setDescription("Run or call ID"));
	}
	if (name === "cancel") {
		return command.addStringOption((option) =>
			option.setName("id").setDescription("Turn or trace ID").setRequired(true),
		);
	}
	if (name === "revoke") {
		return command.addStringOption((option) => option.setName("id").setDescription("Bypass ID").setRequired(true));
	}
	if (name === "bash") {
		return command.addStringOption((option) =>
			option.setName("command").setDescription("Command to run").setRequired(true),
		);
	}
	return command;
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

type DiscordAttachmentUploadResult = {
	requested: number;
	resolved: number;
	status: "uploaded" | "failed" | "unknown";
	messageIds: string[];
};

export async function sendDiscordOutput(input: {
	channel: TextBasedChannel;
	token?: string;
	store?: AttachmentStore;
	out: Outbound;
	replyTo?: Message;
	skipFirst?: boolean;
	logger: Logger;
	context: Record<string, unknown>;
	delivery: DeliveryQueue;
}): Promise<string[]> {
	const ids = await sendTextChunks({
		channel: input.channel,
		text: input.out.text,
		approval: input.out.approval,
		replyTo: input.replyTo,
		skipFirst: input.skipFirst,
		context: input.context,
		delivery: input.delivery,
	});
	const upload = await uploadDiscordAttachments({
		channel: input.channel,
		token: input.token,
		store: input.store,
		attachments: input.out.attachments,
		scope: input.out.attachmentScope,
		logger: input.logger,
		context: input.context,
		delivery: input.delivery,
	});
	await postDiscordAttachmentUploadNotice({
		channel: input.channel,
		upload,
		context: input.context,
		delivery: input.delivery,
	});
	return [...ids, ...upload.messageIds];
}

async function sendTextChunks(input: {
	channel: TextBasedChannel;
	text: string;
	approval?: Outbound["approval"];
	replyTo?: Message;
	skipFirst?: boolean;
	context: Record<string, unknown>;
	delivery: DeliveryQueue;
}): Promise<string[]> {
	if (input.approval && !input.skipFirst) {
		const approval = input.approval;
		const sent = await input.delivery.run(
			() =>
				sendTo(input.channel, input.replyTo, {
					embeds: [approvalEmbed(approval, "pending")],
					components: approvalComponents(approval),
				}),
			{ ...input.context, retry: "send" },
		);
		return [sent.id];
	}
	const chunks = chunkText(discordMarkdown(input.text), DISCORD_TEXT_LIMIT);
	const ids: string[] = [];
	for (let index = input.skipFirst ? 1 : 0; index < chunks.length; index++) {
		const sent = await input.delivery.run(
			() =>
				sendTo(input.channel, input.replyTo, {
					content: chunks[index],
				}),
			{ ...input.context, retry: "send" },
		);
		ids.push(sent.id);
	}
	return ids;
}

function discordReplyStream(input: {
	config?: ReplyStreamOption;
	message: Message;
	reply?: boolean;
	logger: Logger;
	context: Record<string, unknown>;
	delivery: DeliveryQueue;
	takeoverFirstMessage?: () => Promise<string | undefined>;
}) {
	if (!input.config || (typeof input.config === "object" && input.config.enabled === false)) return undefined;
	return new DraftReplyStream(
		{
			limit: DISCORD_TEXT_LIMIT,
			create: async (text) => {
				const adopted = await input.takeoverFirstMessage?.();
				if (adopted) {
					const msg = await input.message.channel.messages.fetch(adopted);
					await input.delivery.run(() => msg.edit({ content: text, embeds: [], components: [] }), input.context);
					return adopted;
				}
				const sent = await input.delivery.run(
					() =>
						sendTo(input.message.channel, input.reply === false ? undefined : input.message, { content: text }),
					{
						...input.context,
						retry: "send",
					},
				);
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
	reply?: boolean;
	progress?: DiscordProgress;
	cancelId?: string;
	logger: Logger;
	context: Record<string, unknown>;
	delivery: DeliveryQueue;
}) {
	const placeholder = delayedProgressPlaceholder({
		message: input.progress?.message === false ? false : (input.progress?.message ?? "Working..."),
		delayMs: input.progress?.delayMs ?? 1000,
		send: async (text) => {
			const msg = await input.delivery
				.run(
					() =>
						sendTo(input.message.channel, input.reply === false ? undefined : input.message, {
							content: text,
							components: progressComponents(input.cancelId),
						}),
					{
						...input.context,
						retry: "send",
					},
				);
			return msg.id;
		},
		onError: (error) =>
			input.logger.warn("discord.progress.message_failed", { ...input.context, error: errorMessage(error) }),
	});
	return {
		async notify(next: string): Promise<void> {
			const id = placeholder.setText(next);
			if (!id) return;
			try {
				const msg = await input.message.channel.messages.fetch(id);
				await input.delivery.run(
					() => msg.edit({ content: next, components: progressComponents(input.cancelId) }),
					input.context,
				);
			} catch (error) {
				input.logger.warn("discord.progress.notify_failed", {
					...input.context,
					error: errorMessage(error),
				});
			}
		},
		async update(out: Outbound): Promise<boolean> {
			const messageId = await placeholder.take();
			if (!messageId) return false;
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
				return true;
			} catch (error) {
				input.logger.warn("discord.progress.update_failed", { ...input.context, error: errorMessage(error) });
				return false;
			}
		},
		async takeover(): Promise<string | undefined> {
			return await placeholder.take();
		},
		async stop(): Promise<void> {
			const messageId = await placeholder.clear();
			if (!messageId) return;
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
	token?: string;
	store?: AttachmentStore;
	attachments?: Array<{ path: string; name?: string; mimeType?: string }>;
	scope?: ScopedKey;
	logger: Logger;
	context: Record<string, unknown>;
	delivery: DeliveryQueue;
}): Promise<DiscordAttachmentUploadResult> {
	const requested = input.attachments?.length ?? 0;
	if (!requested) return { requested, resolved: 0, status: "uploaded", messageIds: [] };
	const resolved = await resolveOutboundAttachments({
		provider: "discord",
		store: input.store,
		attachments: input.attachments,
		scope: input.scope,
		logger: input.logger,
		context: input.context,
	});
	if (!resolved.length) return { requested, resolved: 0, status: "failed", messageIds: [] };
	const names = resolved.map((file) => file.name);
	const method = input.token ? "rest" : "channel";
	try {
		const sent = await sendDiscordAttachmentUpload(
			input.channel,
			input.token,
			resolved,
			input.delivery,
			input.context,
		);
		input.logger.debug("discord.attachment_upload_done", {
			...input.context,
			method,
			requested,
			resolved: resolved.length,
		});
		return { requested, resolved: resolved.length, status: "uploaded", messageIds: [sent.id] };
	} catch (error) {
		const ambiguous = ambiguousDiscordSendError(error);
		if (ambiguous) {
			const found = await findRecentDiscordAttachmentUpload(input.channel, names).catch((lookupError) => {
				input.logger.debug("discord.attachment_upload_lookup_failed", {
					...input.context,
					method,
					error: errorMessage(lookupError),
				});
				return undefined;
			});
			if (found) {
				input.logger.debug("discord.attachment_upload_found_after_abort", {
					...input.context,
					method,
					requested,
					resolved: resolved.length,
					message: found,
				});
				return { requested, resolved: resolved.length, status: "uploaded", messageIds: [found] };
			}
			// Sending files is not idempotent; retrying favors visible delivery over silent loss.
			try {
				const sent = await sendDiscordAttachmentUpload(
					input.channel,
					input.token,
					resolved,
					input.delivery,
					input.context,
				);
				input.logger.debug("discord.attachment_upload_retry_done", {
					...input.context,
					method,
					requested,
					resolved: resolved.length,
				});
				return { requested, resolved: resolved.length, status: "uploaded", messageIds: [sent.id] };
			} catch (retryError) {
				input.logger.warn("discord.attachment_upload_retry_failed", {
					...input.context,
					method,
					error: errorMessage(retryError),
				});
			}
		}
		input.logger.warn(ambiguous ? "discord.attachment_upload_ambiguous" : "discord.attachment_upload_failed", {
			...input.context,
			method,
			error: errorMessage(error),
		});
		return { requested, resolved: resolved.length, status: ambiguous ? "unknown" : "failed", messageIds: [] };
	}
}

async function sendDiscordAttachmentUpload(
	channel: TextBasedChannel,
	token: string | undefined,
	files: Array<{ path: string; name: string }>,
	delivery: DeliveryQueue,
	context: Record<string, unknown>,
): Promise<{ id: string }> {
	return await delivery.run(
		async () =>
			token
				? await sendDiscordAttachmentUploadViaRest(channel, token, files)
				: await sendDiscordAttachmentUploadViaChannel(channel, files),
		{ ...context, retry: "send" },
	);
}

async function sendDiscordAttachmentUploadViaChannel(
	channel: TextBasedChannel,
	files: Array<{ path: string; name: string }>,
): Promise<Message> {
	const attachments = await Promise.all(
		files.map(async (file) => new AttachmentBuilder(await readFile(file.path), { name: file.name })),
	);
	return await sendTo(channel, undefined, {
		content: attachmentUploadText(files.map((file) => file.name)),
		files: attachments,
	});
}

async function sendDiscordAttachmentUploadViaRest(
	channel: TextBasedChannel,
	token: string,
	files: Array<{ path: string; name: string }>,
): Promise<{ id: string }> {
	const form = new FormData();
	form.append("payload_json", JSON.stringify({ content: attachmentUploadText(files.map((file) => file.name)) }));
	for (const [index, file] of files.entries()) {
		const bytes = await readFile(file.path);
		form.append(`files[${index}]`, new Blob([bytes]), file.name);
	}
	const response = await fetch(`https://discord.com/api/v10/channels/${channel.id}/messages`, {
		method: "POST",
		headers: { Authorization: `Bot ${token}` },
		body: form,
		signal: AbortSignal.timeout(DISCORD_ATTACHMENT_UPLOAD_TIMEOUT_MS),
	});
	const json = (await response.json().catch(() => undefined)) as
		| { id?: unknown; message?: unknown; retry_after?: unknown }
		| undefined;
	if (!response.ok) {
		const message = typeof json?.message === "string" ? json.message : response.statusText;
		throw discordRestError(`Discord attachment upload failed: ${response.status} ${message}`, json?.retry_after);
	}
	if (typeof json?.id !== "string") throw new Error("Discord attachment upload returned no message id");
	return { id: json.id };
}

function discordRestError(message: string, retryAfter: unknown): Error {
	const error = new Error(message) as Error & { retryAfter?: number };
	if (typeof retryAfter === "number" && Number.isFinite(retryAfter)) error.retryAfter = retryAfter;
	return error;
}

async function findRecentDiscordAttachmentUpload(
	channel: TextBasedChannel,
	names: string[],
): Promise<string | undefined> {
	if (!("messages" in channel)) return undefined;
	const messages = await channel.messages.fetch({ limit: 10 });
	const expected = attachmentUploadText(names);
	for (const message of messages.values()) {
		if (message.author.id !== message.client.user?.id) continue;
		if (message.content !== expected) continue;
		const attached = [...message.attachments.values()].map((item) => item.name);
		if (names.every((name) => attached.includes(name))) return message.id;
	}
	return undefined;
}

async function indexDiscordProviderMessages(input: {
	start: AdapterStart;
	provider: string;
	team?: string;
	channel: string;
	thread: string;
	actor?: string;
	ids: string[];
}): Promise<void> {
	const agent = input.start.app?.agent;
	const store = input.start.store;
	if (!agent || !store?.providerMessages || input.ids.length === 0) return;
	const row = await store.threads.getByKey(agent, input.provider, input.team, input.thread);
	if (!row) return;
	for (const id of input.ids) {
		await store.providerMessages.upsert({
			agent,
			provider: input.provider,
			team: input.team,
			channel: input.channel,
			providerMessageId: id,
			threadId: row.id,
			actor: input.actor,
		});
	}
}

async function postDiscordAttachmentUploadNotice(input: {
	channel: TextBasedChannel;
	upload: DiscordAttachmentUploadResult;
	context: Record<string, unknown>;
	delivery: DeliveryQueue;
}): Promise<void> {
	const text = attachmentUploadNoticeText({
		upload: input.upload,
		acceptedHint:
			"I created the file, but Discord did not accept the upload. Check the bot's attachment permissions and server logs.",
		unknownHint:
			"I created the file, but Discord did not confirm the upload. If no file appears, retry the upload or check the bot's attachment permissions and server logs.",
	});
	if (!text) return;
	await sendTextChunks({
		channel: input.channel,
		text,
		context: input.context,
		delivery: input.delivery,
	});
}

function ambiguousDiscordSendError(error: unknown): boolean {
	if (error instanceof DOMException && error.name === "AbortError") return true;
	const text = errorMessage(error).toLowerCase();
	return text.includes("operation was aborted") || text.includes("aborterror");
}

function approvalComponents(approval: NonNullable<Outbound["approval"]>) {
	return [
		new ActionRowBuilder<ButtonBuilder>().addComponents(
			new ButtonBuilder()
				.setCustomId(controlActionCallback({ kind: "approve", id: approval.id }, DISCORD_ACTIONS))
				.setLabel(controlActionLabel("approve"))
				.setStyle(ButtonStyle.Success),
			new ButtonBuilder()
				.setCustomId(controlActionCallback({ kind: "deny", id: approval.id }, DISCORD_ACTIONS))
				.setLabel(controlActionLabel("deny"))
				.setStyle(ButtonStyle.Danger),
		),
	];
}

function progressComponents(cancelId?: string) {
	const buttons = [
		cancelId
			? new ButtonBuilder()
					.setCustomId(controlActionCallback({ kind: "cancel", id: cancelId }, DISCORD_ACTIONS))
					.setLabel(controlActionLabel("cancel"))
					.setStyle(ButtonStyle.Danger)
			: undefined,
		new ButtonBuilder()
			.setCustomId(controlActionCallback({ kind: "status" }, DISCORD_ACTIONS))
			.setLabel(controlActionLabel("status"))
			.setStyle(ButtonStyle.Secondary),
	].filter((button): button is ButtonBuilder => Boolean(button));
	return buttons.length ? [new ActionRowBuilder<ButtonBuilder>().addComponents(...buttons)] : [];
}

export function approvalView(input: { approval?: Outbound["approval"]; state: ApprovalViewState; actor?: string }): {
	title: string;
	color: number;
	fields: Array<{ name: string; value: string; inline?: boolean }>;
} {
	const fields = approvalViewRows({
		approval: input.approval,
		state: input.state,
		actor: input.actor,
		formatActor: (actor) => `<@${actor}>`,
	}).map((row) => ({
		name: truncateEmbedValue(row.label, 256),
		value: row.format === "code" ? codeValue(row.value) : truncateEmbedValue(row.value),
	}));
	return { title: approvalTitle(input.state), color: approvalColor(input.state), fields };
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
	const builder = EmbedBuilder.from(embed).addFields({
		name: "Status",
		value: truncateEmbedValue(out.text),
	});
	if (state) builder.setColor(approvalColor(state));
	return builder;
}

function approvalColor(state: ApprovalViewState): number {
	if (state === "approved") return APPROVAL_APPROVED_COLOR;
	if (state === "rejected") return APPROVAL_REJECTED_COLOR;
	if (state === "expired") return APPROVAL_EXPIRED_COLOR;
	return APPROVAL_PENDING_COLOR;
}

type DiscordAction = ControlAction;

function parseAction(input: string): DiscordAction | undefined {
	return parseControlAction(input, DISCORD_ACTIONS);
}

function discordActionText(action: DiscordAction): string {
	return controlActionText(action);
}

function approvedFallbackText(actor: string, text: string, id?: string): string {
	const prefix = id ? `Approval \`${id}\` approved by <@${actor}>.` : `Approved by <@${actor}>.`;
	return [prefix, text].filter(Boolean).join("\n\n");
}

function approvalTitle(state: ApprovalViewState): string {
	return approvalViewTitle(state);
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

async function discordThreadKey(input: {
	start: AdapterStart;
	provider: string;
	team?: string;
	channel: string;
	actor: string;
	message: Message;
	response?: DiscordResponse;
}): Promise<string> {
	if (isDm(input.message) || discordThread(input.message)) return threadKey(input.message);
	const agent = input.start.app?.agent;
	const store = input.start.store;
	if (!agent || !store) return threadKey(input.message);
	const replyMessageId = input.message.reference?.messageId;
	if (replyMessageId && store.providerMessages) {
		const found = await store.providerMessages.get({
			agent,
			provider: input.provider,
			team: input.team,
			channel: input.channel,
			providerMessageId: replyMessageId,
		});
		if (found) return (await store.threads.get(found.threadId))?.key ?? found.threadId;
	}
	const continueRecentMs = input.response?.continueRecentMs ?? 300_000;
	if (continueRecentMs !== false && store.threads.getRecentForActor) {
		const recent = await store.threads.getRecentForActor({
			agent,
			provider: input.provider,
			team: input.team,
			channel: input.channel,
			actor: input.actor,
			since: Date.now() - continueRecentMs,
		});
		if (recent && !(await store.locks?.get(`thread:${recent.id}`))) return recent.key;
	}
	return `${input.channel}:${input.message.id}`;
}

function discordReplyPlacement(response: DiscordResponse | undefined, msg: Message): boolean {
	if (response?.placement === "reply") return true;
	if (response?.placement === "same") return false;
	return !isDm(msg) && !discordThread(msg);
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

function discordAllowConfigured(allow: DiscordAllow | undefined): boolean {
	return Boolean(
		allow?.channels?.length ||
			allow?.users?.length ||
			allow?.groups?.length ||
			botAllowConfigured(allow?.bots) ||
			allow?.dms === false,
	);
}

function discordThread(msg: Message): boolean {
	const channel = msg.channel as { isThread?: () => boolean };
	return typeof channel.isThread === "function" && channel.isThread();
}

function discordProgress(input: DiscordConfig["progress"]): DiscordProgress | undefined {
	return normalizeProgressConfig(input);
}

function resolveDiscordConfig(input: DiscordConfig): DiscordConfig & { token: string } {
	return {
		...input,
		token: input.token ?? requiredEnv("DISCORD_BOT_TOKEN", "Discord bot token"),
		clientId: input.clientId ?? optionalEnv("DISCORD_CLIENT_ID"),
	};
}

export function discordAllowed(
	input: DiscordAllow | undefined,
	event: { channel: string; user: string; groups?: string[]; bot?: string; botSelf?: string; isDm: boolean },
): { ok: true } | { ok: false; reason: string } {
	return allowByDimensions({
		dms: input?.dms,
		isDm: event.isDm,
		dmReason: "dm disabled",
		dimensions: [
			{ allowlist: input?.channels, value: event.channel, reason: "channel not allowed", skip: event.isDm },
			{ allowlist: actorAllowlist(input), value: discordActorValue(input, event), reason: "actor not allowed" },
		],
	});
}

function discordActorValue(
	allow: DiscordAllow | undefined,
	event: { user?: string; groups?: string[]; bot?: string; botSelf?: string },
): string | undefined {
	return actorAllowedValue({
		allow,
		user: event.user,
		groups: event.groups,
		botAllowed: event.bot ? discordBotAllowed(allow?.bots, event.bot, event.botSelf) : undefined,
	});
}

export function discordBotAllowed(
	allow: DiscordAllow["bots"] | undefined,
	bot: string,
	self: string | undefined,
): boolean {
	return botIdentityAllowed({ allow, botIds: [bot], selfIds: [self] });
}

const DISCORD_GROUP_CACHE_MS = 60_000;

class DiscordGroupResolver {
	private readonly groups: string[];
	private readonly cache = new Map<string, { groups: string[]; expiresAt: number }>();

	constructor(
		groups: string[],
		private readonly logger: Logger,
	) {
		this.groups = [...new Set(groups)];
	}

	async forMessage(message: Message): Promise<string[]> {
		if (this.groups.length === 0 || !message.guild) return [];
		return await this.forMember({
			guild: message.guild,
			user: message.author.id,
			roles: rolesFromMember(message.member),
		});
	}

	async forInteraction(interaction: Interaction): Promise<string[]> {
		if (this.groups.length === 0 || !interaction.guild || !interaction.isRepliable()) return [];
		return await this.forMember({
			guild: interaction.guild,
			user: interaction.user.id,
			roles: rolesFromMember(interaction.member),
		});
	}

	private async forMember(input: {
		guild: NonNullable<Message["guild"]>;
		user: string;
		roles: string[];
	}): Promise<string[]> {
		const key = `${input.guild.id}:${input.user}`;
		const cached = this.cache.get(key);
		if (cached && cached.expiresAt > Date.now()) return cached.groups;
		let roles = input.roles;
		if (roles.length === 0) {
			try {
				const member = await input.guild.members.fetch(input.user);
				roles = rolesFromMember(member);
			} catch (error) {
				this.logger.warn("discord.role_lookup_failed", {
					guild: input.guild.id,
					user: input.user,
					error: errorMessage(error),
				});
			}
		}
		const groups = this.groups.filter((group) => roles.includes(group));
		this.cache.set(key, { groups, expiresAt: Date.now() + DISCORD_GROUP_CACHE_MS });
		return groups;
	}
}

function rolesFromMember(member: unknown): string[] {
	if (!member || typeof member !== "object") return [];
	const roles = (member as { roles?: unknown }).roles;
	if (Array.isArray(roles)) return roles.filter((role): role is string => typeof role === "string");
	const cache = (roles as { cache?: Map<string, unknown> } | undefined)?.cache;
	return cache instanceof Map ? [...cache.keys()] : [];
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

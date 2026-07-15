import { readFile } from "node:fs/promises";
import { approvalActorAllowed, renderApprovalMessage } from "./approval.js";
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
	BusyMode,
	ChatMessage,
} from "./types.js";
import { createTypingControls, typingEvents } from "./typing.js";

const APPROVE = "heypi_approve";
const REJECT = "heypi_reject";
const TELEGRAM_TEXT_LIMIT = 4_096;

export type TelegramConfig = {
	id?: string;
	token: string;
	botUsername?: string;
	pollMs?: number;
	allow?: AllowConfig;
	admins?: ApproverSet;
	approvers?: ApproverSet;
	approvals?: AdapterApprovalConfig;
	busy?: BusyMode;
	typing?: boolean;
	events?: AdapterEvents;
};

export type TelegramBotIdentity = {
	id?: number;
	username?: string;
};

export type TelegramUpdate = {
	update_id: number;
	message?: TelegramMessage;
	callback_query?: TelegramCallbackQuery;
};

export type TelegramMessage = {
	message_id: number;
	message_thread_id?: number;
	text?: string;
	chat: {
		id: number;
		type?: string;
		title?: string;
	};
	from?: {
		id: number;
		username?: string;
		first_name?: string;
		is_bot?: boolean;
	};
	document?: { file_id: string; file_name?: string; mime_type?: string };
	photo?: Array<{ file_id: string }>;
	reply_to_message?: { message_id: number };
};

export type TelegramCallbackQuery = {
	id: string;
	data?: string;
	from: {
		id: number;
		username?: string;
		first_name?: string;
	};
	message?: {
		message_id: number;
		chat: { id: number };
	};
};

type PendingApproval = {
	view: ApprovalView;
	conversation?: string;
	message?: number;
	timer?: ReturnType<typeof setTimeout>;
	resolve(decision: ApprovalDecision): void;
};

export type TelegramApprovalPayload = {
	chat_id: string;
	message_thread_id?: number;
	reply_parameters?: { message_id: number };
	text: string;
	reply_markup: {
		inline_keyboard: Array<Array<{ text: string; callback_data: string }>>;
	};
};

export type TelegramTypingPayload = {
	chat_id: string;
	action: "typing";
};

export function telegramMessage(
	message: TelegramMessage,
	bot?: string | TelegramBotIdentity,
	adapterId = "telegram",
): ChatMessage {
	const text = message.text ?? "";
	const botIdentity = telegramBotIdentity(bot);
	const username = botIdentity.username?.replace(/^@/, "");
	const isSelf = Boolean(botIdentity.id !== undefined && message.from?.id === botIdentity.id);
	return {
		id: String(message.message_id),
		adapter: "telegram",
		adapterId,
		conversation: String(message.chat.id),
		thread: message.message_thread_id ? String(message.message_thread_id) : undefined,
		...(message.reply_to_message ? { replyTo: String(message.reply_to_message.message_id) } : {}),
		user: {
			id: String(message.from?.id ?? "unknown"),
			name: message.from?.username ?? message.from?.first_name,
			isBot: message.from?.is_bot === true,
			...(isSelf ? { isSelf: true } : {}),
		},
		text,
		mentioned: username ? new RegExp(`@${escapeRegExp(username)}\\b`, "i").test(text) : false,
		dm: message.chat.type === "private",
		attachments: [
			...(message.document
				? [
						{
							id: message.document.file_id,
							name: message.document.file_name,
							mime: message.document.mime_type,
						},
					]
				: []),
			...(message.photo?.map((photo) => ({ id: photo.file_id, name: "photo" })) ?? []),
		],
	};
}

export function telegramTypingPayload(message: ChatMessage): TelegramTypingPayload {
	return {
		chat_id: message.conversation,
		action: "typing",
	};
}

function telegramAttachmentKind(attachment: { name?: string; mime?: string }): "image" | "document" {
	if (attachment.mime?.startsWith("image/")) return "image";
	const name = attachment.name?.toLowerCase() ?? "";
	if (
		name.endsWith(".gif") ||
		name.endsWith(".jpeg") ||
		name.endsWith(".jpg") ||
		name.endsWith(".png") ||
		name.endsWith(".webp")
	)
		return "image";
	return "document";
}

async function uploadTelegramAttachment(
	token: string,
	message: { conversation: string; thread?: string; replyTo?: string },
	attachment: { localPath?: string; name?: string; mime?: string },
	caption?: string,
): Promise<number> {
	if (!attachment.localPath) throw new Error("Telegram attachment has no local path");
	const data = await readFile(attachment.localPath);
	const kind = telegramAttachmentKind(attachment);
	const method = kind === "image" ? "sendPhoto" : "sendDocument";
	const field = kind === "image" ? "photo" : "document";
	const form = new FormData();
	form.set("chat_id", message.conversation);
	if (message.thread) form.set("message_thread_id", message.thread);
	if (message.replyTo) form.set("reply_parameters", JSON.stringify({ message_id: Number(message.replyTo) }));
	if (caption) form.set("caption", caption);
	form.set(field, new Blob([data], { type: attachment.mime ?? "application/octet-stream" }), attachment.name);
	const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, { method: "POST", body: form });
	const payload = (await response.json()) as { ok?: boolean; result?: { message_id: number }; description?: string };
	if (!response.ok || !payload.ok || !payload.result) throw new Error(payload.description ?? `${method} failed`);
	return payload.result.message_id;
}

export function telegramApprovalPayload(view: ApprovalView): TelegramApprovalPayload {
	return {
		chat_id: view.conversation ?? "",
		message_thread_id: view.thread ? Number(view.thread) : undefined,
		...(view.replyTo ? { reply_parameters: { message_id: Number(view.replyTo) } } : {}),
		text: renderApprovalMessage(view),
		reply_markup: {
			inline_keyboard: [
				[
					{ text: "Approve", callback_data: `${APPROVE}:${view.id}` },
					{ text: "Reject", callback_data: `${REJECT}:${view.id}` },
				],
			],
		},
	};
}

export function telegram(config: TelegramConfig): Adapter {
	let running = false;
	let offset = 0;
	let self: TelegramBotIdentity = { username: config.botUsername };
	const pending = new Map<string, PendingApproval>();
	const pollMs = config.pollMs ?? 1500;
	const api = `https://api.telegram.org/bot${config.token}`;
	const fileApi = `https://api.telegram.org/file/bot${config.token}`;
	const adapterId = config.id ?? "telegram";

	async function call<T>(method: string, body: Record<string, unknown>): Promise<T> {
		const response = await fetch(`${api}/${method}`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
		});
		if (!response.ok) throw new Error(`Telegram ${method} failed: ${response.status}`);
		const payload = (await response.json()) as { ok: boolean; result: T; description?: string };
		if (!payload.ok) throw new Error(payload.description ?? `Telegram ${method} failed`);
		return payload.result;
	}

	const typing = createTypingControls(4000, (message) => call("sendChatAction", telegramTypingPayload(message)));

	async function poll(
		receive: (message: ChatMessage) => Promise<void>,
		logger: AdapterContext["logger"],
	): Promise<void> {
		while (running) {
			try {
				const updates = await call<TelegramUpdate[]>("getUpdates", { timeout: 20, offset });
				for (const update of updates) {
					offset = Math.max(offset, update.update_id + 1);
					if (update.callback_query) {
						await handleCallback(update.callback_query);
						continue;
					}
					if (!update.message) continue;
					const message = telegramMessage(update.message, self, adapterId);
					if (message.user.isSelf) continue;
					if (!message.dm && !message.mentioned && !message.replyTo) continue;
					await receive(message);
				}
			} catch (error) {
				logger.warn("adapter.telegram.poll_error", {
					error: error instanceof Error ? error.message : String(error),
				});
			}
			await new Promise((resolve) => setTimeout(resolve, pollMs));
		}
	}

	async function handleCallback(callback: TelegramCallbackQuery): Promise<void> {
		const [action, id] = callback.data?.split(":") ?? [];
		const approval = id ? pending.get(id) : undefined;
		if (!approval || (action !== APPROVE && action !== REJECT)) return;
		const approved = action === APPROVE;
		const resolvedBy = callback.from.username ? `@${callback.from.username}` : String(callback.from.id);
		const resolvedById = String(callback.from.id);
		if (!approvalActorAllowed({ approved, resolvedBy, resolvedById }, config.approvers, config.admins)) {
			await call("answerCallbackQuery", { callback_query_id: callback.id });
			return;
		}
		pending.delete(id);
		if (approval.timer) clearTimeout(approval.timer);
		await call("answerCallbackQuery", { callback_query_id: callback.id });
		if (callback.message) {
			await call("editMessageText", {
				chat_id: callback.message.chat.id,
				message_id: callback.message.message_id,
				text: renderApprovalMessage({
					...approval.view,
					state: approved ? "approved" : "rejected",
					resolvedBy,
				}),
			});
		}
		approval.resolve({
			approved,
			messageIds: approval.message === undefined ? undefined : [String(approval.message)],
			resolvedBy,
			resolvedById,
			reason: approved ? undefined : "Rejected in Telegram.",
		});
	}

	return {
		kind: "telegram",
		id: adapterId,
		allow: config.allow,
		admins: config.admins,
		approvers: config.approvers,
		approvals: config.approvals,
		busy: config.busy ?? "queue",
		events: typingEvents(config.typing, config.events, typing),
		async start(context) {
			self = await loadTelegramBotIdentity(call, context.logger, config.botUsername);
			running = true;
			void poll(context.receive, context.logger).catch((error) => {
				context.logger.error("adapter.telegram.error", {
					error: error instanceof Error ? error.message : String(error),
				});
			});
			context.logger.info("adapter.telegram.start");
		},
		stop() {
			typing.stopAll();
			running = false;
		},
		async materializeAttachments(message, target) {
			return {
				...message,
				attachments: await materializeAdapterAttachments(message.attachments, {
					dir: target.dir,
					displayDir: target.displayDir,
					resolveUrl: async (attachment) => {
						if (attachment.url) return attachment.url;
						if (!attachment.id) return undefined;
						const file = await call<{ file_path?: string }>("getFile", { file_id: attachment.id });
						return file.file_path ? `${fileApi}/${file.file_path}` : undefined;
					},
				}),
			};
		},
		async send(message) {
			const { local, references } = splitLocalAttachments(message.attachments);
			const ids: string[] = [];
			if (local.length > 0) {
				const chunks = chunkText(formatOutgoingText(message.text, references), TELEGRAM_TEXT_LIMIT);
				const prefixes = chunks.slice(0, -1);
				for (const [index, chunk] of prefixes.entries()) {
					const result = await call<{ message_id: number }>("sendMessage", {
						chat_id: message.conversation,
						message_thread_id: message.thread ? Number(message.thread) : undefined,
						reply_parameters:
							index === 0 && message.replyTo ? { message_id: Number(message.replyTo) } : undefined,
						text: chunk,
					});
					ids.push(String(result.message_id));
				}
				const caption = chunks.at(-1);
				for (const [index, attachment] of local.entries()) {
					const messageId = await uploadTelegramAttachment(
						config.token,
						index === 0 && prefixes.length === 0 ? message : { ...message, replyTo: undefined },
						attachment,
						index === 0 ? caption : undefined,
					);
					ids.push(String(messageId));
				}
				return { id: ids[0], ids };
			}
			for (const [index, text] of chunkText(
				formatOutgoingText(message.text, message.attachments),
				TELEGRAM_TEXT_LIMIT,
			).entries()) {
				const result = await call<{ message_id: number }>("sendMessage", {
					chat_id: message.conversation,
					message_thread_id: message.thread ? Number(message.thread) : undefined,
					reply_parameters: index === 0 && message.replyTo ? { message_id: Number(message.replyTo) } : undefined,
					text,
				});
				ids.push(String(result.message_id));
			}
			return { id: ids[0], ids };
		},
		async update(message) {
			await call("editMessageText", {
				chat_id: message.conversation,
				message_id: Number(message.id),
				text: formatOutgoingText(message.text, message.attachments),
			});
		},
		async requestApproval(view) {
			if (!view.conversation) return { approved: false, reason: "Telegram approval has no target conversation." };
			const sent = await call<{ message_id: number }>("sendMessage", telegramApprovalPayload(view));
			return new Promise<ApprovalDecision>((resolve) => {
				const pendingApproval: PendingApproval = {
					view,
					conversation: view.conversation,
					message: sent.message_id,
					resolve,
				};
				const timeoutMs = config.approvals?.timeoutMs;
				if (timeoutMs && timeoutMs > 0) {
					pendingApproval.timer = setTimeout(() => {
						if (!pending.delete(view.id)) return;
						void call("editMessageText", {
							chat_id: view.conversation,
							message_id: sent.message_id,
							text: renderApprovalMessage({ ...view, state: "rejected", resolvedBy: "timeout" }),
						}).catch(() => undefined);
						resolve({ approved: false, messageIds: [String(sent.message_id)], reason: "Approval expired." });
					}, timeoutMs);
				}
				pending.set(view.id, pendingApproval);
			});
		},
	};
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function telegramBotIdentity(bot: string | TelegramBotIdentity | undefined): TelegramBotIdentity {
	if (typeof bot === "string") return { username: bot };
	return bot ?? {};
}

async function loadTelegramBotIdentity(
	call: <T>(method: string, body: Record<string, unknown>) => Promise<T>,
	logger: { warn(event: string, fields?: Record<string, unknown>): void },
	configUsername: string | undefined,
): Promise<TelegramBotIdentity> {
	try {
		const result = await call<{ id: number; username?: string }>("getMe", {});
		return { id: result.id, username: configUsername ?? result.username };
	} catch (error) {
		logger.warn("telegram.get_me_failed", { message: error instanceof Error ? error.message : String(error) });
		return { username: configUsername };
	}
}

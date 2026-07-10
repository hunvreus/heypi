import { renderApprovalMessage } from "./approval.js";
import type { AdapterEvent, AdapterEventHandler, AdapterEvents, AdapterEventType } from "./events.js";
import { formatOutgoingText } from "./message.js";
import type {
	Adapter,
	AdapterApprovalConfig,
	AllowConfig,
	ApprovalDecision,
	ApprovalView,
	ApproverSet,
	ChatMessage,
} from "./types.js";

const APPROVE = "heypi_approve";
const REJECT = "heypi_reject";

export type TelegramConfig = {
	name?: string;
	token: string;
	botUsername?: string;
	pollMs?: number;
	allow?: AllowConfig;
	admins?: ApproverSet;
	approvers?: ApproverSet;
	approvals?: AdapterApprovalConfig;
	progress?: boolean;
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

type TypingControls = {
	start(message: ChatMessage): void;
	stop(message: ChatMessage): void;
	stopAll(): void;
};

export type TelegramApprovalPayload = {
	chat_id: string;
	message_thread_id?: number;
	text: string;
	reply_markup: {
		inline_keyboard: Array<Array<{ text: string; callback_data: string }>>;
	};
};

export type TelegramTypingPayload = {
	chat_id: string;
	action: "typing";
};

export function telegramMessage(message: TelegramMessage, bot?: string | TelegramBotIdentity): ChatMessage {
	const text = message.text ?? "";
	const botIdentity = telegramBotIdentity(bot);
	const username = botIdentity.username?.replace(/^@/, "");
	const isSelf = Boolean(botIdentity.id !== undefined && message.from?.id === botIdentity.id);
	return {
		id: String(message.message_id),
		adapter: "telegram",
		account: "telegram",
		conversation: String(message.chat.id),
		thread: message.message_thread_id ? String(message.message_thread_id) : undefined,
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

export function telegramApprovalPayload(view: ApprovalView): TelegramApprovalPayload {
	return {
		chat_id: view.conversation ?? "",
		message_thread_id: view.thread ? Number(view.thread) : undefined,
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

function typingKey(message: ChatMessage): string {
	return `${message.conversation}:${message.thread ?? ""}`;
}

function createTypingControls(sendTyping: (message: ChatMessage) => Promise<void>): TypingControls {
	const timers = new Map<string, ReturnType<typeof setInterval>>();
	return {
		start(message) {
			const key = typingKey(message);
			if (timers.has(key)) return;
			void sendTyping(message);
			timers.set(
				key,
				setInterval(() => {
					void sendTyping(message);
				}, 4000),
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
		...events,
		"turn.started": wrap("turn.started", (_event, context) => typing.start(context.message)),
		"message.completed": wrap("message.completed", (_event, context) => typing.stop(context.message)),
		"turn.failed": wrap("turn.failed", (_event, context) => typing.stop(context.message)),
		"turn.canceled": wrap("turn.canceled", (_event, context) => typing.stop(context.message)),
	};
}

export function telegram(config: TelegramConfig): Adapter {
	let running = false;
	let offset = 0;
	let self: TelegramBotIdentity = { username: config.botUsername };
	const pending = new Map<string, PendingApproval>();
	const pollMs = config.pollMs ?? 1500;
	const api = `https://api.telegram.org/bot${config.token}`;

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

	const typing = createTypingControls((message) => call("sendChatAction", telegramTypingPayload(message)));

	async function poll(receive: (message: ChatMessage) => Promise<void>): Promise<void> {
		while (running) {
			const updates = await call<TelegramUpdate[]>("getUpdates", { timeout: 20, offset });
			for (const update of updates) {
				offset = Math.max(offset, update.update_id + 1);
				if (update.callback_query) {
					await handleCallback(update.callback_query);
					continue;
				}
				if (!update.message) continue;
				const message = telegramMessage(update.message, self);
				if (message.user.isSelf) continue;
				if (!message.dm && !message.mentioned) continue;
				await receive(message);
			}
			await new Promise((resolve) => setTimeout(resolve, pollMs));
		}
	}

	async function handleCallback(callback: TelegramCallbackQuery): Promise<void> {
		const [action, id] = callback.data?.split(":") ?? [];
		const approval = id ? pending.get(id) : undefined;
		if (!approval || (action !== APPROVE && action !== REJECT)) return;
		pending.delete(id);
		if (approval.timer) clearTimeout(approval.timer);
		const approved = action === APPROVE;
		const resolvedBy = callback.from.username ? `@${callback.from.username}` : String(callback.from.id);
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
			resolvedBy,
			resolvedById: String(callback.from.id),
			reason: approved ? undefined : "Rejected in Telegram.",
		});
	}

	return {
		kind: "telegram",
		name: config.name,
		allow: config.allow,
		admins: config.admins,
		approvers: config.approvers,
		approvals: config.approvals,
		progress: config.progress ?? false,
		events: withTypingEvents(config.events, typing),
		async start(context) {
			self = await loadTelegramBotIdentity(call, context.logger, config.botUsername);
			running = true;
			void poll(context.receive).catch((error) => {
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
		async ack(message) {
			await call("sendChatAction", telegramTypingPayload(message));
		},
		async send(message) {
			const result = await call<{ message_id: number }>("sendMessage", {
				chat_id: message.conversation,
				message_thread_id: message.thread ? Number(message.thread) : undefined,
				text: formatOutgoingText(message.text, message.attachments),
			});
			return { id: String(result.message_id) };
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
						resolve({ approved: false, reason: "Approval expired." });
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

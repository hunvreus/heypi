import { readFile } from "node:fs/promises";
import { message as errorMessage, type Logger, userError } from "../core/log.js";
import { chunkText } from "../render/chunk.js";
import type { Attachment, AttachmentStore, ResolvedAttachment } from "./attachments.js";
import type { Adapter, AdapterStart, Handler, Outbound } from "./handler.js";

const APPROVE = "approve";
const DENY = "deny";
const CANCEL = "cancel";
const STATUS = "status";
const TELEGRAM_TEXT_LIMIT = 4096;
const TELEGRAM_CALLBACK_LIMIT = 200;

export type TelegramConfig = {
	token: string;
	apiUrl?: string;
	pollTimeoutSeconds?: number;
	progress?: TelegramProgress | false;
};

export type TelegramProgress = {
	message?: string | false;
	delayMs?: number;
};

/** Creates a Telegram long-polling adapter. */
export function telegram(input: TelegramConfig): Adapter {
	const client = new TelegramClient(input.token, input.apiUrl);
	let stopped = false;
	let loop: Promise<void> | undefined;
	let activeLogger: Logger | undefined;

	return {
		async start(start: AdapterStart): Promise<void> {
			activeLogger = start.logger;
			stopped = false;
			start.logger.info("adapter.start", { adapter: "telegram" });
			loop = poll({ client, start, config: input, stopped: () => stopped });
		},
		async stop(): Promise<void> {
			stopped = true;
			await loop;
			activeLogger?.info("adapter.stop", { adapter: "telegram" });
		},
	};
}

async function poll(input: {
	client: TelegramClient;
	start: AdapterStart;
	config: TelegramConfig;
	stopped: () => boolean;
}): Promise<void> {
	let offset = 0;
	const timeout = input.config.pollTimeoutSeconds ?? 25;
	while (!input.stopped()) {
		try {
			const updates = await input.client.getUpdates({ offset, timeout });
			for (const update of updates) {
				offset = Math.max(offset, update.update_id + 1);
				await handleUpdate({ ...input, update });
			}
		} catch (error) {
			input.start.logger.warn("telegram.poll_failed", { adapter: "telegram", error: errorMessage(error) });
			await sleep(1000);
		}
	}
}

async function handleUpdate(input: {
	client: TelegramClient;
	start: AdapterStart;
	config: TelegramConfig;
	update: TelegramUpdate;
	stopped: () => boolean;
}): Promise<void> {
	const callback = input.update.callback_query;
	if (callback) {
		await handleCallback({
			client: input.client,
			handler: input.start.handler,
			logger: input.start.logger,
			store: input.start.attachments,
			callback,
		});
		return;
	}
	const msg = input.update.message;
	if (!msg?.chat || msg.from?.is_bot) return;
	const channel = String(msg.chat.id);
	const actor = String(msg.from?.id ?? "unknown");
	const thread = threadKey(msg);
	const trace = `telegram:${msg.message_id}`;
	const progress = input.config.progress === false ? undefined : input.config.progress;
	const pending = startProgress({
		client: input.client,
		chatId: msg.chat.id,
		threadId: msg.message_thread_id,
		replyTo: msg.message_id,
		cancelId: trace,
		progress,
		logger: input.start.logger,
		context: { trace, adapter: "telegram", channel, thread, event: input.update.update_id },
	});
	try {
		const attachments = await telegramAttachments({
			client: input.client,
			store: input.start.attachments,
			message: msg,
			messageId: String(msg.message_id),
			trace,
			logger: input.start.logger,
		});
		const out = await input.start.handler({
			trace,
			provider: "telegram",
			eventId: String(input.update.update_id),
			channel,
			actor,
			thread,
			text: textOf(msg),
			attachments,
			data: msg,
		});
		if (out) {
			const edited = await pending.update(out);
			await sendTelegramOutput({
				client: input.client,
				store: input.start.attachments,
				message: msg,
				out,
				skipFirst: edited,
				logger: input.start.logger,
				context: { trace, adapter: "telegram", channel, thread },
			});
		}
	} catch (error) {
		input.start.logger.error("adapter.error", {
			trace,
			adapter: "telegram",
			channel,
			thread,
			error: errorMessage(error),
		});
		const text = userError("handler");
		const edited = await pending.update({ text });
		await sendChunks({ client: input.client, message: msg, text, skipFirst: edited });
	} finally {
		await pending.stop();
	}
}

async function handleCallback(input: {
	client: TelegramClient;
	handler: Handler;
	logger: Logger;
	store?: AttachmentStore;
	callback: TelegramCallbackQuery;
}): Promise<void> {
	const msg = input.callback.message;
	const action = parseCallback(input.callback.data);
	if (!msg || !action) {
		await input.client.answerCallbackQuery({ callback_query_id: input.callback.id, text: "Unknown action" });
		return;
	}
	const channel = String(msg.chat.id);
	const actor = String(input.callback.from.id);
	const thread = threadKey(msg);
	const trace = `telegram:${input.callback.id}`;
	try {
		const out = await input.handler({
			trace,
			provider: "telegram",
			eventId: input.callback.id,
			channel,
			actor,
			thread,
			text: actionText(action),
			data: input.callback,
		});
		if (!out) {
			await input.client.answerCallbackQuery({ callback_query_id: input.callback.id });
			return;
		}
		if (out.private) {
			await input.client.answerCallbackQuery({
				callback_query_id: input.callback.id,
				text: truncate(out.text, TELEGRAM_CALLBACK_LIMIT),
				show_alert: true,
			});
			return;
		}
		await input.client.answerCallbackQuery({ callback_query_id: input.callback.id });
		await input.client.editMessageText({
			chat_id: msg.chat.id,
			message_id: msg.message_id,
			text: firstChunk(out.text, Boolean(out.approval)),
			reply_markup: out.approval ? approvalMarkup(out.approval) : undefined,
		});
		await sendTelegramOutput({
			client: input.client,
			store: input.store,
			message: msg,
			out,
			skipFirst: true,
			logger: input.logger,
			context: { trace, adapter: "telegram", channel, thread },
		});
	} catch (error) {
		input.logger.error("adapter.error", {
			trace,
			adapter: "telegram",
			channel,
			thread,
			error: errorMessage(error),
		});
		await input.client.answerCallbackQuery({
			callback_query_id: input.callback.id,
			text: userError("handler"),
			show_alert: true,
		});
	}
}

async function sendTelegramOutput(input: {
	client: TelegramClient;
	store?: AttachmentStore;
	message: TelegramMessage;
	out: Outbound;
	skipFirst?: boolean;
	logger: Logger;
	context: Record<string, unknown>;
}): Promise<void> {
	await sendChunks({
		client: input.client,
		message: input.message,
		text: input.out.text,
		approval: input.out.approval,
		skipFirst: input.skipFirst,
	});
	await uploadTelegramAttachments({
		client: input.client,
		store: input.store,
		message: input.message,
		attachments: input.out.attachments,
		logger: input.logger,
		context: input.context,
	});
}

async function sendChunks(input: {
	client: TelegramClient;
	message: TelegramMessage;
	text: string;
	approval?: Outbound["approval"];
	skipFirst?: boolean;
}): Promise<void> {
	const chunks = telegramChunks(input.text, Boolean(input.approval));
	for (let index = input.skipFirst ? 1 : 0; index < chunks.length; index++) {
		await input.client.sendMessage({
			chat_id: input.message.chat.id,
			message_thread_id: input.message.message_thread_id,
			text: chunks[index],
			reply_to_message_id: input.message.message_id,
			reply_markup: index === 0 && input.approval ? approvalMarkup(input.approval) : undefined,
		});
	}
}

async function uploadTelegramAttachments(input: {
	client: TelegramClient;
	store?: AttachmentStore;
	message: TelegramMessage;
	attachments?: Array<{ path: string; name?: string; mimeType?: string }>;
	logger: Logger;
	context: Record<string, unknown>;
}): Promise<void> {
	if (!input.attachments?.length) return;
	if (!input.store) {
		input.logger.warn("telegram.attachments_missing_store", input.context);
		return;
	}
	for (const attachment of input.attachments) {
		let file: ResolvedAttachment;
		try {
			file = await input.store.resolve(attachment);
		} catch (error) {
			input.logger.warn("telegram.attachment_resolve_failed", {
				...input.context,
				path: attachment.path,
				error: errorMessage(error),
			});
			continue;
		}
		try {
			await input.client.sendDocument({
				chat_id: input.message.chat.id,
				message_thread_id: input.message.message_thread_id,
				reply_to_message_id: input.message.message_id,
				document: file,
			});
		} catch (error) {
			input.logger.warn("telegram.attachment_upload_failed", { ...input.context, error: errorMessage(error) });
		}
	}
}

function startProgress(input: {
	client: TelegramClient;
	chatId: number;
	threadId?: number;
	replyTo: number;
	cancelId: string;
	progress?: TelegramProgress;
	logger: Logger;
	context: Record<string, unknown>;
}) {
	let active = true;
	let placeholder: number | undefined;
	let task: Promise<void> | undefined;
	const message = input.progress ? (input.progress.message ?? "Thinking...") : false;
	if (message) {
		task = new Promise((resolve) => {
			setTimeout(() => {
				if (!active) {
					resolve();
					return;
				}
				input.client
					.sendMessage({
						chat_id: input.chatId,
						message_thread_id: input.threadId,
						reply_to_message_id: input.replyTo,
						text: message,
						reply_markup: progressMarkup(input.cancelId),
					})
					.then((out) => {
						placeholder = out.message_id;
					})
					.catch((error) => {
						input.logger.warn("telegram.progress.message_failed", {
							...input.context,
							error: errorMessage(error),
						});
					})
					.finally(resolve);
			}, input.progress?.delayMs ?? 750);
		});
	}
	return {
		async update(out: Outbound): Promise<boolean> {
			active = false;
			await task;
			if (!placeholder) return false;
			const messageId = placeholder;
			placeholder = undefined;
			try {
				await input.client.editMessageText({
					chat_id: input.chatId,
					message_id: messageId,
					text: firstChunk(out.text, Boolean(out.approval)),
					reply_markup: out.approval ? approvalMarkup(out.approval) : undefined,
				});
				return true;
			} catch (error) {
				input.logger.warn("telegram.progress.update_failed", { ...input.context, error: errorMessage(error) });
				return false;
			}
		},
		async stop(): Promise<void> {
			active = false;
			await task;
			if (!placeholder) return;
			await input.client.deleteMessage({ chat_id: input.chatId, message_id: placeholder }).catch((error) => {
				input.logger.warn("telegram.progress.delete_failed", { ...input.context, error: errorMessage(error) });
			});
		},
	};
}

async function telegramAttachments(input: {
	client: TelegramClient;
	store?: AttachmentStore;
	message: TelegramMessage;
	messageId: string;
	trace: string;
	logger: Logger;
}): Promise<Attachment[] | undefined> {
	if (!input.store) return undefined;
	const files = filesOf(input.message);
	if (!files.length) return undefined;
	const out: Attachment[] = [];
	for (const file of files) {
		try {
			const found = await input.client.getFile({ file_id: file.id });
			const data = await input.client.downloadFile(found.file_path);
			out.push(
				await input.store.save({
					provider: "telegram",
					id: file.id,
					name: file.name,
					data,
					mimeType: file.mimeType,
					messageId: input.messageId,
				}),
			);
		} catch (error) {
			input.logger.warn("telegram.attachment_failed", {
				trace: input.trace,
				adapter: "telegram",
				file: file.id,
				error: errorMessage(error),
			});
		}
	}
	return out.length ? out : undefined;
}

function textOf(msg: TelegramMessage): string {
	return msg.text ?? msg.caption ?? "";
}

function threadKey(msg: TelegramMessage): string {
	return `${msg.chat.id}:${msg.message_thread_id ?? msg.chat.id}`;
}

function actionText(action: TelegramAction): string {
	if (action.kind === STATUS) return "status";
	return `${action.kind} ${action.id}`;
}

export function telegramChunks(text: string, hasMarkup = false): string[] {
	return chunkText(text, hasMarkup ? 3800 : TELEGRAM_TEXT_LIMIT);
}

function firstChunk(text: string, hasMarkup: boolean): string {
	return telegramChunks(text, hasMarkup)[0] ?? "";
}

function progressMarkup(id: string): TelegramReplyMarkup {
	return {
		inline_keyboard: [
			[
				{ text: "Cancel", callback_data: `${CANCEL}:${id}` },
				{ text: "Status", callback_data: STATUS },
			],
		],
	};
}

function approvalMarkup(approval: NonNullable<Outbound["approval"]>): TelegramReplyMarkup {
	return {
		inline_keyboard: [
			[
				{ text: "Approve", callback_data: `${APPROVE}:${approval.id}` },
				{ text: "Deny", callback_data: `${DENY}:${approval.id}` },
			],
		],
	};
}

type TelegramAction =
	| { kind: "approve"; id: string }
	| { kind: "deny"; id: string }
	| { kind: "cancel"; id: string }
	| { kind: "status" };

export function parseTelegramCallback(input?: string): TelegramAction | undefined {
	return parseCallback(input);
}

function parseCallback(input?: string): TelegramAction | undefined {
	if (!input) return undefined;
	if (input === STATUS) return { kind: STATUS };
	const index = input.indexOf(":");
	if (index <= 0) return undefined;
	const kind = input.slice(0, index);
	const id = input.slice(index + 1);
	if (!id) return undefined;
	if (kind === APPROVE || kind === DENY || kind === CANCEL) return { kind, id };
	return undefined;
}

function filesOf(msg: TelegramMessage): Array<{ id: string; name: string; mimeType?: string }> {
	const out: Array<{ id: string; name: string; mimeType?: string }> = [];
	if (msg.document) {
		out.push({
			id: msg.document.file_id,
			name: msg.document.file_name ?? `${msg.document.file_id}.bin`,
			mimeType: msg.document.mime_type,
		});
	}
	if (msg.photo?.length) {
		const photo = [...msg.photo].sort((a, b) => (b.file_size ?? 0) - (a.file_size ?? 0))[0];
		if (photo)
			out.push({ id: photo.file_id, name: `${photo.file_unique_id ?? photo.file_id}.jpg`, mimeType: "image/jpeg" });
	}
	return out;
}

function truncate(text: string, limit: number): string {
	return text.length <= limit ? text : `${text.slice(0, Math.max(0, limit - 1))}…`;
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

class TelegramClient {
	private readonly base: string;

	constructor(
		private readonly token: string,
		apiUrl = "https://api.telegram.org",
	) {
		this.base = `${apiUrl.replace(/\/+$/, "")}/bot${token}`;
	}

	async getUpdates(input: { offset: number; timeout: number }): Promise<TelegramUpdate[]> {
		const out = await this.call<{ result: TelegramUpdate[] }>("getUpdates", input);
		return out.result;
	}

	async sendMessage(input: TelegramSendMessage): Promise<TelegramMessage> {
		const out = await this.call<{ result: TelegramMessage }>("sendMessage", compact(input));
		return out.result;
	}

	async editMessageText(input: TelegramEditMessageText): Promise<void> {
		await this.call("editMessageText", compact(input));
	}

	async deleteMessage(input: { chat_id: number; message_id: number }): Promise<void> {
		await this.call("deleteMessage", input);
	}

	async answerCallbackQuery(input: TelegramAnswerCallbackQuery): Promise<void> {
		await this.call("answerCallbackQuery", compact(input));
	}

	async getFile(input: { file_id: string }): Promise<{ file_path: string }> {
		const out = await this.call<{ result: { file_path: string } }>("getFile", input);
		return out.result;
	}

	async downloadFile(path: string): Promise<Uint8Array> {
		const url = `${this.baseFile}/${path}`;
		const response = await fetch(url);
		if (!response.ok) throw new Error(`Telegram file download failed: ${response.status}`);
		return new Uint8Array(await response.arrayBuffer());
	}

	async sendDocument(input: {
		chat_id: number;
		message_thread_id?: number;
		reply_to_message_id?: number;
		document: ResolvedAttachment;
	}): Promise<void> {
		const form = new FormData();
		const data = await readFile(input.document.path);
		form.set("chat_id", String(input.chat_id));
		if (input.message_thread_id !== undefined) form.set("message_thread_id", String(input.message_thread_id));
		if (input.reply_to_message_id !== undefined) form.set("reply_to_message_id", String(input.reply_to_message_id));
		form.set("document", new Blob([data], { type: input.document.mimeType }), input.document.name);
		await this.callForm("sendDocument", form);
	}

	private get baseFile(): string {
		const root = this.base.slice(0, this.base.indexOf(`/bot${this.token}`));
		return `${root}/file/bot${this.token}`;
	}

	private async call<T = unknown>(method: string, body: unknown): Promise<T> {
		const response = await fetch(`${this.base}/${method}`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
		});
		const parsed = (await response.json()) as TelegramResponse<T>;
		if (!response.ok || !parsed.ok) throw new Error(parsed.description ?? `Telegram API failed: ${response.status}`);
		return parsed as T;
	}

	private async callForm(method: string, body: FormData): Promise<void> {
		const response = await fetch(`${this.base}/${method}`, { method: "POST", body });
		const parsed = (await response.json()) as TelegramResponse<unknown>;
		if (!response.ok || !parsed.ok) throw new Error(parsed.description ?? `Telegram API failed: ${response.status}`);
	}
}

function compact<T extends Record<string, unknown>>(input: T): T {
	const out: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(input)) if (value !== undefined) out[key] = value;
	return out as T;
}

type TelegramResponse<T> = T & { ok?: boolean; description?: string };

type TelegramUpdate = {
	update_id: number;
	message?: TelegramMessage;
	callback_query?: TelegramCallbackQuery;
};

type TelegramCallbackQuery = {
	id: string;
	from: TelegramUser;
	data?: string;
	message?: TelegramMessage;
};

type TelegramUser = {
	id: number;
	is_bot?: boolean;
};

type TelegramMessage = {
	message_id: number;
	message_thread_id?: number;
	from?: TelegramUser;
	chat: { id: number; type?: string };
	text?: string;
	caption?: string;
	document?: {
		file_id: string;
		file_name?: string;
		mime_type?: string;
	};
	photo?: Array<{
		file_id: string;
		file_unique_id?: string;
		file_size?: number;
	}>;
};

type TelegramReplyMarkup = {
	inline_keyboard: Array<Array<{ text: string; callback_data: string }>>;
};

type TelegramSendMessage = {
	chat_id: number;
	message_thread_id?: number;
	reply_to_message_id?: number;
	text: string;
	reply_markup?: TelegramReplyMarkup;
};

type TelegramEditMessageText = {
	chat_id: number;
	message_id: number;
	text: string;
	reply_markup?: TelegramReplyMarkup;
};

type TelegramAnswerCallbackQuery = {
	callback_query_id: string;
	text?: string;
	show_alert?: boolean;
};

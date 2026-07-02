import type { Adapter, AdapterContext, AdapterKind, ChatMessage, SendMessage } from "../types.js";

type BaseAdapterConfig = {
	name?: string;
	onStart?: (context: AdapterContext) => Promise<void> | void;
	onSend?: (message: SendMessage) => Promise<{ id?: string } | void> | { id?: string } | void;
	onAck?: (message: ChatMessage) => Promise<void> | void;
};

function adapter(kind: AdapterKind, config: BaseAdapterConfig = {}): Adapter {
	return {
		kind,
		name: config.name,
		start: (context) => config.onStart?.(context),
		send: async (message) => config.onSend?.(message),
		ack: (message) => config.onAck?.(message),
	};
}

export type SlackConfig = BaseAdapterConfig & {
	token?: string;
	appToken?: string;
	signingSecret?: string;
};

export type DiscordConfig = BaseAdapterConfig & {
	token?: string;
};

export type TelegramConfig = BaseAdapterConfig & {
	token?: string;
};

export type WebhookConfig = BaseAdapterConfig & {
	path?: string;
};

export function slack(config: SlackConfig = {}): Adapter {
	return adapter("slack", config);
}

export function discord(config: DiscordConfig = {}): Adapter {
	return adapter("discord", config);
}

export function telegram(config: TelegramConfig = {}): Adapter {
	return adapter("telegram", config);
}

export function webhook(config: WebhookConfig = {}): Adapter {
	return adapter("webhook", config);
}


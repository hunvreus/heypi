import { join } from "node:path";
import { stageAgent } from "./agent.js";
import { createApprovalExtension } from "./approval.js";
import { type Channel, createChannel } from "./channel.js";
import { createChatHistoryTool, createChatReplyTool } from "./chat-tools.js";
import { consoleLogger } from "./log.js";
import { createPiHost, type PiHost, type PiHostOptions, sessionDir } from "./pi.js";
import type { Adapter, AgentConfig, ChatMessage, Logger } from "./types.js";

export type HeypiApp = {
	start(): Promise<void>;
	stop(): Promise<void>;
};

export type CreateHeypiOptions = {
	agent: AgentConfig | Promise<AgentConfig>;
	logger?: Logger;
	piHost?: PiHostFactory;
};

export type PiHostFactory = (options: PiHostOptions) => PiHost;

type RunningChannel = {
	channel: Channel;
	adapter: Adapter;
	pi?: PiHost;
};

function keyFor(message: ChatMessage): string {
	return `${message.adapter}:${message.account}:${message.conversation}`.replace(/[^a-zA-Z0-9_.:-]/g, "_");
}

function assistantText(message: { role?: string; content?: unknown }): string {
	const content = message.content;
	if (Array.isArray(content)) {
		return content
			.map((part) => (part && typeof part === "object" && "text" in part ? String(part.text) : ""))
			.join("");
	}
	return typeof content === "string" ? content : "";
}

export async function createHeypi(options: CreateHeypiOptions): Promise<HeypiApp> {
	const agent = await options.agent;
	const logger = options.logger ?? consoleLogger;
	const piHost = options.piHost ?? createPiHost;
	const stateDir = agent.state?.dir ?? join(process.cwd(), ".heypi");
	const staged = await stageAgent(agent, stateDir);
	const channels = new Map<string, RunningChannel>();

	async function channelFor(adapter: Adapter, message: ChatMessage): Promise<RunningChannel> {
		const key = keyFor(message);
		const cached = channels.get(key);
		if (cached) return cached;
		const channel = createChannel({
			logPath: join(stateDir, "channels", `${key}.jsonl`),
			context: agent.context,
		});
		await channel.load();
		const running = { adapter, channel };
		channels.set(key, running);
		return running;
	}

	async function startPi(running: RunningChannel, message: ChatMessage): Promise<PiHost> {
		if (running.pi) return running.pi;
		const adapter = running.adapter;
		const channel = running.channel;
		const key = keyFor(message);
		const approvalExtension =
			agent.approvals?.enabled === false
				? undefined
				: createApprovalExtension({
						config: agent.approvals,
						context: () => ({
							adapter: message.adapter,
							account: message.account,
							conversation: message.conversation,
							thread: channel.activeMessageId(),
							actor: channel.activeUser(),
						}),
						request: (view) =>
							adapter.requestApproval?.({
								...view,
								conversation: message.conversation,
								thread: channel.activeMessageId(),
							}) ??
							Promise.resolve({ approved: false, reason: `${adapter.kind} adapter cannot approve tools.` }),
					});
		const pi = piHost({
			agent,
			agentDir: staged.agentDir,
			workspaceDir: staged.workspaceDir,
			sessionDir: sessionDir(stateDir, key),
			extensionPaths: staged.extensionPaths,
			tools: [
				createChatHistoryTool(channel),
				createChatReplyTool(async (text) => {
					await adapter.send({ conversation: message.conversation, thread: channel.activeMessageId(), text });
				}),
			],
			extensions: approvalExtension ? [approvalExtension] : undefined,
		});
		await pi.start();
		running.pi = pi;
		return pi;
	}

	async function dispatch(running: RunningChannel, message: ChatMessage): Promise<void> {
		const turn = running.channel.next();
		if (!turn) return;
		let finalText = "";
		let unsubscribe: (() => void) | undefined;
		try {
			const pi = await startPi(running, message);
			unsubscribe = pi.subscribe((event) => {
				if (event.type === "message_end" && event.message.role === "assistant") {
					finalText = assistantText(event.message);
				}
			});
			await pi.send(turn.prompt);
			if (finalText.trim()) {
				await running.adapter.send({ conversation: message.conversation, thread: turn.messageId, text: finalText });
			}
			await running.channel.complete(finalText);
		} catch (error) {
			const text = error instanceof Error ? error.message : String(error);
			await running.channel.fail(text);
			await running.adapter.send({
				conversation: message.conversation,
				thread: turn.messageId,
				text: `The agent failed: ${text}`,
			});
		} finally {
			unsubscribe?.();
		}
		await dispatch(running, message);
	}

	async function receive(adapter: Adapter, message: ChatMessage): Promise<void> {
		try {
			await adapter.ack?.(message);
		} catch (error) {
			logger.warn("adapter.ack_failed", {
				adapter: adapter.kind,
				message: error instanceof Error ? error.message : String(error),
			});
		}
		const running = await channelFor(adapter, message);
		const queued = await running.channel.ingest(message);
		if (queued) {
			await dispatch(running, message);
		}
	}

	return {
		async start() {
			for (const adapter of agent.adapters ?? []) {
				await adapter.start({ agentId: agent.id, logger, receive: (message) => receive(adapter, message) });
			}
			logger.info("app.start", { agent: agent.id, adapters: agent.adapters?.length ?? 0 });
		},
		async stop() {
			for (const channel of channels.values()) await channel.pi?.stop();
			for (const adapter of agent.adapters ?? []) await adapter.stop?.();
			logger.info("app.stop", { agent: agent.id });
		},
	};
}

export async function runHeypi(agent: AgentConfig | Promise<AgentConfig>): Promise<HeypiApp> {
	const app = await createHeypi({ agent });
	await app.start();
	return app;
}

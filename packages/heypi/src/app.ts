import { join } from "node:path";
import { stageAgent } from "./agent.js";
import { createApprovalExtension } from "./approval.js";
import { createChatHistoryTool } from "./chat-history.js";
import { createChatReplyTool } from "./chat-reply.js";
import { ConversationRuntime } from "./conversation.js";
import { consoleLogger } from "./log.js";
import { PiSessionHost, piSessionDir } from "./pi/session.js";
import type { Adapter, AgentConfig, ChatMessage, Logger } from "./types.js";

export type HeypiApp = {
	start(): Promise<void>;
	stop(): Promise<void>;
};

export type CreateHeypiOptions = {
	agent: AgentConfig | Promise<AgentConfig>;
	logger?: Logger;
};

type RunningConversation = {
	runtime: ConversationRuntime;
	pi: PiSessionHost;
	adapter: Adapter;
};

export async function createHeypi(options: CreateHeypiOptions): Promise<HeypiApp> {
	const agent = await options.agent;
	const logger = options.logger ?? consoleLogger;
	const stateDir = agent.state?.dir ?? join(process.cwd(), ".heypi");
	const staged = await stageAgent(agent, stateDir);
	const conversations = new Map<string, RunningConversation>();

	async function conversationFor(adapter: Adapter, message: ChatMessage): Promise<RunningConversation> {
		const key = `${message.adapter}:${message.account}:${message.conversation}`.replace(/[^a-zA-Z0-9_.:-]/g, "_");
		const cached = conversations.get(key);
		if (cached) return cached;
		const runtime = new ConversationRuntime({
			logPath: join(stateDir, "conversations", `${key}.jsonl`),
			context: agent.context,
		});
		await runtime.load();
		const pi = new PiSessionHost({
			agent,
			agentDir: staged.agentDir,
			workspaceDir: staged.workspaceDir,
			sessionDir: piSessionDir(stateDir, key),
			toolPaths: staged.toolPaths,
			extensionFactories: agent.approvals
				? [
						createApprovalExtension({
							config: agent.approvals,
							requestedBy: () => runtime.activeUserName(),
							request: (view) =>
								adapter.requestApproval?.({
									...view,
									conversation: message.conversation,
									thread: runtime.activeMessageId(),
								}) ??
								Promise.resolve({
									approved: false,
									reason: `${adapter.kind} adapter does not implement approval UI`,
								}),
						}),
					]
				: undefined,
			customTools: [
				createChatHistoryTool(runtime),
				createChatReplyTool(async (text) => {
					await adapter.send({ conversation: message.conversation, thread: runtime.activeMessageId(), text });
				}),
			],
		});
		await pi.start();
		const running = { runtime, pi, adapter };
		conversations.set(key, running);
		return running;
	}

	async function receive(adapter: Adapter, message: ChatMessage): Promise<void> {
		await adapter.ack?.(message);
		const conversation = await conversationFor(adapter, message);
		const queued = await conversation.runtime.ingest(message);
		if (!queued) return;
		await dispatch(conversation, message.conversation);
	}

	async function dispatch(conversation: RunningConversation, remoteConversation: string): Promise<void> {
		const job = conversation.runtime.beginNext();
		if (!job) return;
		try {
			let finalText = "";
			const unsubscribe = conversation.pi.subscribe((event) => {
				if (event.type === "message_end" && event.message.role === "assistant") {
					const content = event.message.content;
					finalText = Array.isArray(content)
						? content.map((part) => (part.type === "text" ? part.text : "")).join("")
						: String(content);
				}
			});
			await conversation.pi.send(job.prompt);
			unsubscribe();
			await conversation.adapter.send({ conversation: remoteConversation, thread: job.messageId, text: finalText });
			await conversation.runtime.complete(finalText);
			await dispatch(conversation, remoteConversation);
		} catch (error) {
			const messageText = error instanceof Error ? error.message : String(error);
			await conversation.runtime.fail(messageText);
			await conversation.adapter.send({
				conversation: remoteConversation,
				thread: job.messageId,
				text: `The agent failed: ${messageText}`,
			});
			await dispatch(conversation, remoteConversation);
		}
	}

	const adapters = agent.adapters ?? [];
	return {
		async start() {
			for (const adapter of adapters) {
				await adapter.start({
					agentId: agent.id,
					logger,
					receive: (message) => receive(adapter, message),
				});
			}
			logger.info("app.start", { agent: agent.id, adapters: adapters.length });
		},
		async stop() {
			for (const conversation of conversations.values()) await conversation.pi.stop();
			for (const adapter of adapters) await adapter.stop?.();
			logger.info("app.stop", { agent: agent.id });
		},
	};
}

export async function runHeypi(agent: AgentConfig | Promise<AgentConfig>): Promise<HeypiApp> {
	const app = await createHeypi({ agent });
	await app.start();
	return app;
}

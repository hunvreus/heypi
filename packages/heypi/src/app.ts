import { join } from "node:path";
import { stageAgent } from "./agent.js";
import { createApprovalExtension } from "./approval.js";
import { type Channel, createChannel } from "./channel.js";
import { consoleLogger } from "./log.js";
import { createPiHost, type PiHost, sessionDir } from "./pi.js";
import type { Adapter, AgentConfig, ChatMessage, Logger } from "./types.js";

export type HeypiApp = {
	start(): Promise<void>;
	stop(): Promise<void>;
};

export type CreateHeypiOptions = {
	agent: AgentConfig | Promise<AgentConfig>;
	logger?: Logger;
};

type RunningChannel = {
	channel: Channel;
	pi: PiHost;
	adapter: Adapter;
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
		const pi = createPiHost({
			agent,
			agentDir: staged.agentDir,
			workspaceDir: staged.workspaceDir,
			sessionDir: sessionDir(stateDir, key),
			toolPaths: staged.toolPaths,
			extensions: agent.approvals
				? [
						createApprovalExtension({
							config: agent.approvals,
							requestedBy: () => channel.activeUserName(),
							request: (view) =>
								adapter.requestApproval?.({
									...view,
									conversation: message.conversation,
									thread: channel.activeMessageId(),
								}) ??
								Promise.resolve({ approved: false, reason: `${adapter.kind} adapter cannot approve tools.` }),
						}),
					]
				: undefined,
		});
		await pi.start();
		const running = { adapter, channel, pi };
		channels.set(key, running);
		return running;
	}

	async function dispatch(running: RunningChannel, conversation: string): Promise<void> {
		const turn = running.channel.next();
		if (!turn) return;
		let finalText = "";
		const unsubscribe = running.pi.subscribe((event) => {
			if (event.type === "message_end" && event.message.role === "assistant") {
				finalText = assistantText(event.message);
			}
		});
		try {
			await running.pi.send(turn.prompt);
			await running.adapter.send({ conversation, thread: turn.messageId, text: finalText });
			await running.channel.complete(finalText);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			await running.channel.fail(message);
			await running.adapter.send({ conversation, thread: turn.messageId, text: `The agent failed: ${message}` });
		} finally {
			unsubscribe();
		}
		await dispatch(running, conversation);
	}

	async function receive(adapter: Adapter, message: ChatMessage): Promise<void> {
		await adapter.ack?.(message);
		const running = await channelFor(adapter, message);
		const queued = await running.channel.ingest(message);
		if (queued) await dispatch(running, message.conversation);
	}

	return {
		async start() {
			for (const adapter of agent.adapters ?? []) {
				await adapter.start({ agentId: agent.id, logger, receive: (message) => receive(adapter, message) });
			}
			logger.info("app.start", { agent: agent.id, adapters: agent.adapters?.length ?? 0 });
		},
		async stop() {
			for (const channel of channels.values()) await channel.pi.stop();
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

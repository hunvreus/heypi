import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import type { CallContext } from "../core/calls.js";
import { type Logger, logger } from "../core/log.js";
import type { Confirm, Reply, ToolExecute } from "../core/types.js";
import type { Messages } from "../store/types.js";
import { toolConfirm, toolRunner } from "../tool-internal.js";
import { booleanParam, numberParam, optionalString, stringParam, text, toolText } from "./tool-util.js";
import type { Runtime } from "./types.js";

const SENSITIVE = new Set(["bash", "write", "edit"]);

type Core = {
	bash(channel: string, actor: string, command: string, context?: CallContext, signal?: AbortSignal): Promise<Reply>;
	tool(input: {
		channel: string;
		actor: string;
		name: string;
		args: Record<string, unknown>;
		confirm?: Confirm;
		context?: CallContext;
		execute: ToolExecute;
		signal?: AbortSignal;
	}): Promise<Reply>;
};

export function tools(input: {
	runtime: Runtime;
	callRunner: Core;
	messages?: Messages;
	channel: string;
	actor: string;
	context?: CallContext;
	custom?: ToolDefinition[];
	logger?: Logger;
}): ToolDefinition[] {
	const log = input.logger ?? logger;
	const base = runtimeTools(
		input.runtime,
		input.callRunner,
		input.messages,
		input.channel,
		input.actor,
		input.context,
	);
	const merged = new Map(base.map((tool) => [tool.name, tool]));
	for (const tool of input.custom ?? []) {
		if (merged.has(tool.name) && SENSITIVE.has(tool.name)) log.warn("tool.override", { tool: tool.name });
		merged.set(tool.name, wrapTool(tool, input.callRunner, input.channel, input.actor, input.context, log));
	}
	return [...merged.values()];
}

function wrapTool(
	tool: ToolDefinition,
	callRunner: Core,
	channel: string,
	actor: string,
	context: CallContext | undefined,
	log: Logger,
): ToolDefinition {
	const confirm = toolConfirm(tool);
	if (!confirm) return tool;
	const execute = toolRunner(tool);
	if (!execute) {
		log.warn("tool.confirm_rejected", { tool: tool.name, reason: "missing heypi replay runner" });
		return {
			...tool,
			execute: async () => text(`tool=${tool.name} requires confirmation but was not created with heypi tool()`),
		};
	}
	return {
		...tool,
		async execute(toolCallId, params, signal) {
			const reply = await callRunner.tool({
				channel,
				actor,
				name: tool.name,
				args: record(params),
				confirm,
				context: { ...context, toolCall: toolCallId },
				execute,
				signal,
			});
			return toolText(reply.text, Boolean(reply.approval));
		},
	};
}

function record(input: unknown): Record<string, unknown> {
	return input && typeof input === "object" && !Array.isArray(input) ? (input as Record<string, unknown>) : {};
}

function runtimeTools(
	runtime: Runtime,
	callRunner: Core,
	messages: Messages | undefined,
	channel: string,
	actor: string,
	context?: CallContext,
): ToolDefinition[] {
	const out: ToolDefinition[] = [];
	if (messages && context?.thread) {
		out.push({
			name: "history",
			label: "History",
			description: "Search older messages in the current heypi thread when recent context is not enough.",
			parameters: Type.Object({
				query: Type.Optional(Type.String()),
				limit: Type.Optional(Type.Number()),
				before: Type.Optional(Type.Number()),
				includeTools: Type.Optional(Type.Boolean()),
			}),
			execute: async (_id, params) => {
				const rows = await messages.search({
					threadId: context.thread as string,
					query: optionalString(params, "query"),
					limit: numberParam(params, "limit"),
					before: numberParam(params, "before"),
					includeTools: booleanParam(params, "includeTools"),
				});
				if (rows.length === 0) return text("no history");
				return text(
					rows
						.map((row) => {
							const actor = row.actor ? ` actor=${row.actor}` : "";
							return `[${new Date(row.createdAt).toISOString()}] role=${row.role}${actor}\n${row.text}`;
						})
						.join("\n\n"),
				);
			},
		});
	}
	if (runtime.capabilities.bash && runtime.bash) {
		out.push({
			name: "bash",
			label: "Bash",
			description: "Execute a bash command through heypi policy, approval, audit, and runtime controls.",
			parameters: Type.Object({ command: Type.String({ minLength: 1 }) }),
			execute: async (toolCallId, params, signal) => {
				const command = stringParam(params, "command");
				const reply = await callRunner.bash(channel, actor, command, { ...context, toolCall: toolCallId }, signal);
				return toolText(reply.text, Boolean(reply.approval));
			},
		});
	}
	if (runtime.capabilities.read && runtime.read) {
		const read = runtime.read;
		out.push({
			name: "read",
			label: "Read",
			description: "Read a file from the runtime workspace.",
			parameters: Type.Object({
				path: Type.String({ minLength: 1 }),
				offset: Type.Optional(Type.Number()),
				limit: Type.Optional(Type.Number()),
			}),
			execute: async (_id, params) => {
				const result = await read({
					path: stringParam(params, "path"),
					offset: numberParam(params, "offset"),
					limit: numberParam(params, "limit"),
				});
				return text(result?.text ?? "");
			},
		});
	}
	if (runtime.capabilities.write && runtime.write) {
		const write = runtime.write;
		out.push({
			name: "write",
			label: "Write",
			description: "Write a file in the runtime workspace.",
			parameters: Type.Object({ path: Type.String({ minLength: 1 }), content: Type.String() }),
			execute: async (_id, params) => {
				const result = await write({
					path: stringParam(params, "path"),
					content: stringParam(params, "content"),
				});
				return text(`wrote ${result?.bytes ?? 0} bytes to ${result?.path ?? "file"}`);
			},
		});
	}
	if (runtime.capabilities.edit && runtime.edit) {
		const edit = runtime.edit;
		out.push({
			name: "edit",
			label: "Edit",
			description: "Edit a file by exact text replacement in the runtime workspace.",
			parameters: Type.Object({
				path: Type.String({ minLength: 1 }),
				oldText: Type.String({ minLength: 1 }),
				newText: Type.String(),
				replaceAll: Type.Optional(Type.Boolean()),
			}),
			execute: async (_id, params) => {
				const result = await edit({
					path: stringParam(params, "path"),
					oldText: stringParam(params, "oldText"),
					newText: stringParam(params, "newText"),
					replaceAll: booleanParam(params, "replaceAll"),
				});
				return text(`edited ${result?.path ?? "file"}; replacements=${result?.replacements ?? 0}`);
			},
		});
	}
	if (runtime.capabilities.grep && runtime.grep) {
		const grep = runtime.grep;
		out.push({
			name: "grep",
			label: "Grep",
			description: "Search file contents in the runtime workspace.",
			parameters: Type.Object({
				query: Type.String({ minLength: 1 }),
				path: Type.Optional(Type.String()),
				maxResults: Type.Optional(Type.Number()),
			}),
			execute: async (_id, params) => {
				const result = await grep({
					query: stringParam(params, "query"),
					path: optionalString(params, "path"),
					maxResults: numberParam(params, "maxResults"),
				});
				return text(
					(result?.hits ?? []).map((hit) => `${hit.path}:${hit.line} ${hit.text}`).join("\n") || "no matches",
				);
			},
		});
	}
	if (runtime.capabilities.find && runtime.find) {
		const find = runtime.find;
		out.push({
			name: "find",
			label: "Find",
			description: "Find files in the runtime workspace.",
			parameters: Type.Object({
				pattern: Type.Optional(Type.String()),
				path: Type.Optional(Type.String()),
				maxResults: Type.Optional(Type.Number()),
			}),
			execute: async (_id, params) => {
				const result = await find({
					pattern: optionalString(params, "pattern"),
					path: optionalString(params, "path"),
					maxResults: numberParam(params, "maxResults"),
				});
				return text((result?.paths ?? []).join("\n") || "no files");
			},
		});
	}
	if (runtime.capabilities.ls && runtime.ls) {
		const ls = runtime.ls;
		out.push({
			name: "ls",
			label: "List",
			description: "List files in the runtime workspace.",
			parameters: Type.Object({ path: Type.Optional(Type.String()) }),
			execute: async (_id, params) => {
				const result = await ls({ path: optionalString(params, "path") });
				return text((result?.entries ?? []).map((entry) => `${entry.type}\t${entry.path}`).join("\n") || "empty");
			},
		});
	}
	return out;
}

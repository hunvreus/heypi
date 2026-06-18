import { join } from "node:path";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import type { CallContext } from "../core/calls.js";
import { type Logger, logger } from "../core/log.js";
import type { Confirm, Reply, ReplyAttachment, ToolExecute } from "../core/types.js";
import { type CoreToolDefinition, type CoreToolName, defaultTools } from "../core-tools.js";
import type { Messages } from "../store/types.js";
import { toolConfirm, toolPiRunner, toolRunner } from "../tool-internal.js";
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
	core?: CoreToolDefinition[];
	custom?: ToolDefinition[];
	attachments?: ReplyAttachment[];
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
		input.core,
		input.attachments,
	);
	const merged = new Map(base.map((tool) => [tool.name, tool]));
	for (const tool of input.custom ?? []) {
		if (merged.has(tool.name) && SENSITIVE.has(tool.name)) log.warn("tool.override", { tool: tool.name });
		merged.set(
			tool.name,
			wrapTool(tool, input.runtime, input.callRunner, input.channel, input.actor, input.context, log),
		);
	}
	return [...merged.values()];
}

function wrapTool(
	tool: ToolDefinition,
	runtime: Runtime,
	callRunner: Core,
	channel: string,
	actor: string,
	context: CallContext | undefined,
	log: Logger,
): ToolDefinition {
	const confirm = toolConfirm(tool);
	const executePi = toolPiRunner(tool);
	if (!confirm) {
		if (!executePi) return tool;
		return {
			...tool,
			async execute(_toolCallId, params, signal) {
				return await executePi(record(params), {
					runtime,
					runtimeScope: context?.runtimeScope,
					signal,
				});
			},
		};
	}
	const execute = toolRunner(tool);
	if (!execute) {
		log.warn("tool.confirm_rejected", { tool: tool.name, reason: "missing heypi replay runner" });
		return {
			...tool,
			execute: async () => text(`tool=${tool.name} requires confirmation but cannot be replayed after approval`),
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
			return toolText(reply.text, Boolean(reply.approval), reply.approval);
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
	coreDefinitions?: CoreToolDefinition[],
	attachments?: ReplyAttachment[],
): ToolDefinition[] {
	const out: ToolDefinition[] = [];
	const core = coreMap(coreDefinitions);
	if (enabled(core, "history") && messages && context?.thread) {
		out.push({
			name: "history",
			label: "History",
			description: "Search older messages in the current conversation when recent context is not enough.",
			parameters: Type.Object({
				query: Type.Optional(Type.String()),
				limit: Type.Optional(Type.Number()),
				before: Type.Optional(Type.Number()),
				includeTools: Type.Optional(Type.Boolean()),
			}),
			execute: async (id, params) => {
				void id;
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
	if (enabled(core, "bash") && runtime.bash) {
		out.push({
			name: "bash",
			label: "Bash",
			description:
				"Execute a bash command in the runtime workspace. Returns stdout and stderr. Output may be truncated. Some commands may require approval or be blocked by policy.",
			parameters: Type.Object({ command: Type.String({ minLength: 1 }) }),
			execute: async (toolCallId, params, signal) => {
				const command = stringParam(params, "command");
				const reply = await callRunner.bash(channel, actor, command, { ...context, toolCall: toolCallId }, signal);
				return toolText(reply.text, Boolean(reply.approval), reply.approval);
			},
		});
	}
	if (enabled(core, "read") && runtime.read) {
		const read = runtime.read;
		out.push({
			name: "read",
			label: "Read",
			description:
				"Read the contents of a file in the runtime workspace. Supports offset and limit for large files.",
			parameters: Type.Object({
				path: Type.String({ minLength: 1 }),
				offset: Type.Optional(Type.Number()),
				limit: Type.Optional(Type.Number()),
			}),
			execute: async (id, params, signal) => {
				void id;
				const result = await read({
					path: stringParam(params, "path"),
					offset: numberParam(params, "offset"),
					limit: numberParam(params, "limit"),
					signal,
				});
				return text(result?.text ?? "");
			},
		});
	}
	if (enabled(core, "write") && runtime.write) {
		const write = runtime.write;
		out.push({
			name: "write",
			label: "Write",
			description: "Write a file in the runtime workspace, creating it if needed.",
			parameters: Type.Object({ path: Type.String({ minLength: 1 }), content: Type.String() }),
			execute: async (id, params) => {
				void id;
				const result = await write({
					path: stringParam(params, "path"),
					content: stringParam(params, "content"),
				});
				return text(`wrote ${result?.bytes ?? 0} bytes to ${result?.path ?? "file"}`);
			},
		});
	}
	if (enabled(core, "edit") && runtime.edit) {
		const edit = runtime.edit;
		out.push({
			name: "edit",
			label: "Edit",
			description: "Edit a file in the runtime workspace by exact text replacement.",
			parameters: Type.Object({
				path: Type.String({ minLength: 1 }),
				oldText: Type.String({ minLength: 1 }),
				newText: Type.String(),
				replaceAll: Type.Optional(Type.Boolean()),
			}),
			execute: async (id, params) => {
				void id;
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
	if (enabled(core, "grep") && runtime.grep) {
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
			execute: async (id, params, signal) => {
				void id;
				const result = await grep({
					query: stringParam(params, "query"),
					path: optionalString(params, "path"),
					maxResults: numberParam(params, "maxResults"),
					signal,
				});
				return text(
					(result?.hits ?? []).map((hit) => `${hit.path}:${hit.line} ${hit.text}`).join("\n") || "no matches",
				);
			},
		});
	}
	if (enabled(core, "find") && runtime.find) {
		const find = runtime.find;
		out.push({
			name: "find",
			label: "Find",
			description: "Find files in the runtime workspace by path or glob-like pattern.",
			parameters: Type.Object({
				pattern: Type.Optional(Type.String()),
				path: Type.Optional(Type.String()),
				maxResults: Type.Optional(Type.Number()),
			}),
			execute: async (id, params, signal) => {
				void id;
				const result = await find({
					pattern: optionalString(params, "pattern"),
					path: optionalString(params, "path"),
					maxResults: numberParam(params, "maxResults"),
					signal,
				});
				return text((result?.paths ?? []).join("\n") || "no files");
			},
		});
	}
	if (enabled(core, "ls") && runtime.ls) {
		const ls = runtime.ls;
		out.push({
			name: "ls",
			label: "List",
			description: "List files and directories in the runtime workspace.",
			parameters: Type.Object({ path: Type.Optional(Type.String()) }),
			execute: async (id, params, signal) => {
				void id;
				const result = await ls({ path: optionalString(params, "path"), signal });
				return text((result?.entries ?? []).map((entry) => `${entry.type}\t${entry.path}`).join("\n") || "empty");
			},
		});
	}
	if (enabled(core, "attach") && context?.runtimeScope && attachments) {
		const runtimeScope = context.runtimeScope;
		out.push({
			name: "attach",
			label: "Attach",
			description:
				"Attach a file from the runtime workspace to the final chat reply. Use this after creating a document, image, export, archive, or other artifact the user should receive. Prefer this over pasting content that is long, structured, intended for download, or easier to inspect as a file. Do not attach temporary, private, or intermediate files.",
			parameters: Type.Object({
				path: Type.String({ minLength: 1 }),
				name: Type.Optional(Type.String()),
				mimeType: Type.Optional(Type.String()),
			}),
			execute: async (id, params) => {
				void id;
				const path = scopedAttachmentPath(runtimeScope, stringParam(params, "path"));
				const name = optionalString(params, "name");
				const mimeType = optionalString(params, "mimeType");
				const attachment = {
					path,
					scope: runtimeScope,
					...(name ? { name } : {}),
					...(mimeType ? { mimeType } : {}),
				};
				attachments.push(attachment);
				return text(`attached ${attachment.name ?? stringParam(params, "path")}`);
			},
		});
	}
	return out;
}

function coreMap(input: CoreToolDefinition[] | undefined): Map<CoreToolName, CoreToolDefinition> {
	return new Map((input ?? defaultTools()).map((tool) => [tool.name, tool]));
}

function enabled(core: Map<CoreToolName, CoreToolDefinition>, name: CoreToolName): boolean {
	return core.has(name);
}

function scopedAttachmentPath(runtimeScope: string, path: string): string {
	const clean = path.trim().replace(/^\/+/, "");
	if (!clean || clean === ".") throw new Error("path is required");
	if (clean.includes("\0")) throw new Error("path contains invalid character");
	if (clean.split(/[\\/]+/).some((part) => part === "..")) throw new Error("path escapes runtime scope");
	const scopedPrefix = join("scopes", runtimeScope);
	return clean === scopedPrefix || clean.startsWith(`${scopedPrefix}/`) ? clean : join(scopedPrefix, clean);
}

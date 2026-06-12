import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { type ActorPolicy, actorAllowed, hasActorPolicy } from "../core/approvers.js";
import type { Memory } from "../core/memory.js";
import type { ScopedKey } from "../core/scope.js";
import type { Secrets } from "../core/secrets.js";
import type { Skills } from "../core/skills.js";
import { stringParam } from "./tool-util.js";

type WritePolicy = {
	actor: string;
	groups?: string[];
	approvers: ActorPolicy;
};

export function memoryTools(
	memory: Memory | undefined,
	scope: ScopedKey | undefined,
	policy: WritePolicy,
): ToolDefinition[] {
	if (!memory?.enabled() || !scope) return [];
	const assertCanWrite = () => {
		if (memory.writePolicy() === "off") throw new Error("memory writes are disabled");
		if (
			memory.writePolicy() === "approvers" &&
			(!hasActorPolicy(policy.approvers) || !actorAllowed(policy.approvers, policy))
		) {
			throw new Error("memory writes require an approver");
		}
	};
	return [
		{
			name: "memory_read",
			label: "Memory Read",
			description: "Read persistent memory for this chat workspace.",
			parameters: Type.Object({}),
			execute: async () => managedToolText((await memory.read(scope)).trim() || "no memory", "memory_read"),
		},
		{
			name: "memory_write",
			label: "Memory Write",
			description: "Append one concise persistent memory item for this chat workspace.",
			parameters: Type.Object({ content: Type.String({ minLength: 1 }) }),
			execute: async (id, params) => {
				void id;
				assertCanWrite();
				const item = await memory.append(scope, stringParam(params, "content"));
				return managedToolText(`saved memory: ${item}`, "memory_write");
			},
		},
		{
			name: "memory_replace",
			label: "Memory Replace",
			description: "Replace exact text in persistent memory for this chat workspace.",
			parameters: Type.Object({ oldText: Type.String({ minLength: 1 }), newText: Type.String({ minLength: 1 }) }),
			execute: async (id, params) => {
				void id;
				assertCanWrite();
				await memory.replace(scope, stringParam(params, "oldText"), stringParam(params, "newText"));
				return managedToolText("memory updated", "memory_replace");
			},
		},
		{
			name: "memory_delete",
			label: "Memory Delete",
			description: "Delete exact text from persistent memory for this chat workspace.",
			parameters: Type.Object({ text: Type.String({ minLength: 1 }) }),
			execute: async (id, params) => {
				void id;
				assertCanWrite();
				await memory.delete(scope, stringParam(params, "text"));
				return managedToolText("memory deleted", "memory_delete");
			},
		},
	];
}

export function skillTools(
	skills: Skills | undefined,
	scope: ScopedKey | undefined,
	policy: WritePolicy,
): ToolDefinition[] {
	if (!skills?.enabled() || !scope) return [];
	const assertCanWrite = () => {
		if (skills.writePolicy() === "off") throw new Error("skill writes are disabled");
		if (
			skills.writePolicy() === "approvers" &&
			(!hasActorPolicy(policy.approvers) || !actorAllowed(policy.approvers, policy))
		) {
			throw new Error("skill writes require an approver");
		}
	};
	return [
		{
			name: "skill_list",
			label: "Skill List",
			description: "List scoped skills available for this chat workspace.",
			parameters: Type.Object({}),
			execute: async () => {
				const entries = await skills.list(scope);
				if (entries.length === 0) return managedToolText("no skills", "skill_list");
				return managedToolText(
					entries.map((skill) => `${skill.name}: ${skill.description}`).join("\n"),
					"skill_list",
				);
			},
		},
		{
			name: "skill_read",
			label: "Skill Read",
			description: "Read one scoped skill by name.",
			parameters: Type.Object({ name: Type.String({ minLength: 1 }) }),
			execute: async (id, params) => {
				void id;
				const skill = await skills.read(scope, stringParam(params, "name"));
				return managedToolText(skill.text, "skill_read");
			},
		},
		{
			name: "skill_write",
			label: "Skill Write",
			description:
				"Create or replace one scoped skill. Content is the SKILL.md body only; frontmatter is generated from name and description.",
			parameters: Type.Object({
				name: Type.String({ minLength: 1 }),
				description: Type.String({ minLength: 1 }),
				content: Type.String({ minLength: 1 }),
			}),
			execute: async (id, params) => {
				void id;
				assertCanWrite();
				const skill = await skills.write(scope, {
					name: stringParam(params, "name"),
					description: stringParam(params, "description"),
					content: stringParam(params, "content"),
				});
				return managedToolText(`saved skill: ${skill.name}`, "skill_write");
			},
		},
		{
			name: "skill_patch",
			label: "Skill Patch",
			description: "Replace exact text inside one scoped skill.",
			parameters: Type.Object({
				name: Type.String({ minLength: 1 }),
				oldText: Type.String({ minLength: 1 }),
				newText: Type.String({ minLength: 1 }),
				replaceAll: Type.Optional(Type.Boolean()),
			}),
			execute: async (id, params) => {
				void id;
				assertCanWrite();
				const input = params as { replaceAll?: unknown };
				const skill = await skills.patch(scope, {
					name: stringParam(params, "name"),
					oldText: stringParam(params, "oldText"),
					newText: stringParam(params, "newText"),
					replaceAll: input.replaceAll === true,
				});
				return managedToolText(`patched skill: ${skill.name}`, "skill_patch");
			},
		},
		{
			name: "skill_delete",
			label: "Skill Delete",
			description: "Delete one scoped skill by name.",
			parameters: Type.Object({ name: Type.String({ minLength: 1 }) }),
			execute: async (id, params) => {
				void id;
				assertCanWrite();
				await skills.delete(scope, stringParam(params, "name"));
				return managedToolText("skill deleted", "skill_delete");
			},
		},
	];
}

export function secretTools(
	secrets: Secrets | undefined,
	scope: ScopedKey | undefined,
	actor: string | undefined,
): ToolDefinition[] {
	if (!secrets?.enabled() || !scope) return [];
	return [
		{
			name: "secret_request",
			label: "Secret Request",
			description:
				"Request one or more secret values through an encrypted browser handoff. The user opens the link, encrypts the values locally, and pastes the encrypted blob back into chat.",
			parameters: Type.Object({
				reason: Type.String({ minLength: 1 }),
				fields: Type.Array(
					Type.Object({
						name: Type.String({ minLength: 1 }),
						label: Type.Optional(Type.String()),
					}),
					{ minItems: 1 },
				),
			}),
			execute: async (id, params) => {
				void id;
				if (!actor) throw new Error("secret request actor is required");
				const input = params as { fields?: unknown };
				const fields = Array.isArray(input.fields)
					? input.fields.map((field: unknown) => {
							const value = field as { name?: unknown; label?: unknown };
							return {
								name: typeof value.name === "string" ? value.name : "",
								label: typeof value.label === "string" ? value.label : undefined,
							};
						})
					: [];
				const request = secrets.create(scope, { reason: stringParam(params, "reason"), fields, actor });
				return managedToolText(
					[
						"Secret request created.",
						`Open: ${request.url}`,
						"Paste the encrypted heypi-secret blob back into this chat.",
						`Expires: ${new Date(request.expiresAt).toISOString()}`,
						`Fields: ${request.fields.map((field) => field.name).join(", ")}`,
					].join("\n"),
					"secret_request",
				);
			},
		},
	];
}

function managedToolText(text: string, tool: string) {
	return { content: [{ type: "text" as const, text }], details: { tool } };
}

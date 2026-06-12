import type { ApprovalPolicy, CancelPolicy, TaskConfig } from "../config.js";
import { actorAllowed, actorMatches, hasActorPolicy } from "../core/approvers.js";
import { type AppMessages, renderMessage } from "../core/messages.js";
import type { Intent } from "../core/types.js";
import type { ApprovalBypass } from "../store/types.js";
import { channelKey as buildChannelKey } from "./handler-scope.js";

export type CallIntent = Exclude<
	Intent,
	{ kind: "ask" | "help" | "cancel" | "approvals" | "bypasses" | "thread_status" }
>;

export type NormalizedTask = Required<TaskConfig>;

export function requiresThreadLock(kind: string): boolean {
	return kind !== "help" && kind !== "status" && kind !== "approvals" && kind !== "bypasses" && kind !== "revoke";
}

export function scopedIntent(
	intent: CallIntent,
	msg: { provider: string; team?: string; channel: string },
): CallIntent {
	const channelKey = buildChannelKey(msg);
	if (intent.kind === "bash") return { ...intent, channel: channelKey };
	if (intent.kind === "approve") return { ...intent, channel: channelKey };
	if (intent.kind === "deny") return { ...intent, channel: channelKey };
	if (intent.kind === "revoke") return { ...intent, channel: channelKey };
	if (intent.kind === "status") return { ...intent, channel: channelKey };
	return intent;
}

export function canListApprovals(
	config: ApprovalPolicy | undefined,
	actor: { actor: string; actorGroups?: string[]; actorBot?: boolean },
): boolean {
	return actorAllowedForApproval(config, actor);
}

export function canCancelRun(
	policy: CancelPolicy,
	config: ApprovalPolicy | undefined,
	actor: { actor: string; actorGroups?: string[] },
	initiator?: string,
): boolean {
	const identity = { actor: actor.actor, groups: actor.actorGroups };
	if (actorMatches(config?.admins, identity)) return true;
	if (policy === "allowed") return true;
	if (policy === "admin") return false;
	if (actorMatches(config?.approvers, identity)) return true;
	if (policy === "approver") return false;
	return actor.actor === initiator;
}

export function bypassVisible(
	row: ApprovalBypass,
	config: ApprovalPolicy | undefined,
	msg: { provider: string; team?: string; actor: string },
	channel: string,
	threadId: string,
): boolean {
	if (hasActorPolicy(config?.approvers) || hasActorPolicy(config?.admins)) {
		return row.channel.startsWith(`${msg.provider}:${msg.team ?? ""}:`);
	}
	if (row.scope === "thread") return row.threadId === threadId;
	if (row.scope === "channel") return row.channel === channel;
	if (row.scope === "user") return row.actor === msg.actor;
	return row.channel.startsWith(`${msg.provider}:${msg.team ?? ""}:`);
}

export function normalizeTask(input: TaskConfig | undefined): NormalizedTask {
	return {
		busy: input?.busy ?? "steer",
		cancel: input?.cancel ?? "initiator",
	};
}

export function attributedMessage(msg: { actor: string; actorName?: string }, text: string): string {
	const actor = msg.actorName && msg.actorName !== msg.actor ? `${msg.actorName} (${msg.actor})` : msg.actor;
	return `[Message from ${actor}]\n${text}`;
}

export function cancelText(messages: AppMessages, actor: string | undefined): string {
	return renderMessage(messages.cancelled, { actor });
}

export function actorMention(msg: { provider: string; actor: string; actorName?: string }): string {
	if (msg.actorName && msg.actorName !== msg.actor) return msg.actorName;
	if (msg.provider === "slack" || msg.provider === "discord") return `<@${msg.actor}>`;
	return msg.actor;
}

function actorAllowedForApproval(
	config: ApprovalPolicy | undefined,
	actor: { actor: string; actorGroups?: string[]; actorBot?: boolean },
): boolean {
	const identity = { actor: actor.actor, groups: actor.actorGroups };
	if (actorMatches(config?.admins, identity)) return true;
	if (actorMatches(config?.approvers, identity)) return true;
	if (actor.actorBot) return false;
	if (!hasActorPolicy(config?.admins) && !hasActorPolicy(config?.approvers)) return actorAllowed(undefined, identity);
	return false;
}

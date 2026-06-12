import type { Intent } from "./types.js";

function arg(prefix: string, text: string): string | undefined {
	if (!text.startsWith(`${prefix} `)) return undefined;
	const value = text.slice(prefix.length + 1).trim();
	return value || undefined;
}

function bashArg(text: string): { cmd: string } | undefined {
	if (!text.startsWith("/bash ")) return undefined;
	const raw = text.slice(6).trim();
	if (!raw) return undefined;
	return { cmd: raw };
}

export function parseIntent(input: { text: string; channel: string; actor: string }): Intent {
	const text = input.text.trim();
	if (!text) return { kind: "help" };
	if (text === "/help") return { kind: "help" };
	if (text === "/approvals") return { kind: "approvals", channel: input.channel, actor: input.actor };
	if (text === "/bypasses") return { kind: "bypasses", channel: input.channel, actor: input.actor };

	const bash = bashArg(text);
	if (bash) return { kind: "bash", ...bash, channel: input.channel, actor: input.actor };
	if (text === "/bash") return { kind: "help" };

	const approve = arg("/approve", text);
	if (approve) {
		const parts = approve.split(/\s+/u).filter(Boolean);
		const extra = parts.slice(1);
		if (parts.length === 0 || extra.some((part) => part.toLowerCase() !== "bypass")) return { kind: "help" };
		return {
			kind: "approve",
			approvalId: parts[0],
			channel: input.channel,
			actor: input.actor,
			bypass: extra.some((part) => part.toLowerCase() === "bypass"),
		};
	}
	if (text === "/approve") return { kind: "help" };

	const deny = arg("/deny", text);
	if (deny) {
		const parts = deny.split(/\s+/u).filter(Boolean);
		if (parts.length !== 1) return { kind: "help" };
		return { kind: "deny", approvalId: parts[0], channel: input.channel, actor: input.actor };
	}
	if (text === "/deny") return { kind: "help" };

	const cancel = arg("/cancel", text);
	if (cancel) return { kind: "cancel", id: cancel, channel: input.channel, actor: input.actor };
	if (text === "/cancel") return { kind: "help" };

	const revoke = arg("/revoke", text);
	if (revoke) return { kind: "revoke", bypassId: revoke, channel: input.channel, actor: input.actor };
	if (text === "/revoke") return { kind: "help" };

	if (text === "/status") return { kind: "thread_status", channel: input.channel, actor: input.actor };

	const status = arg("/status", text);
	if (status) return { kind: "status", callId: status, channel: input.channel };

	return { kind: "ask", text, channel: input.channel, actor: input.actor };
}

export function normalizeText(text: string): string {
	return text.replace(/<@[^>]+>/g, "").trim();
}

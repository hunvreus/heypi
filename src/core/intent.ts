import type { Intent } from "./types.js";

function arg(prefix: string, text: string): string | undefined {
	if (!text.startsWith(`${prefix} `)) return undefined;
	const value = text.slice(prefix.length + 1).trim();
	return value || undefined;
}

function bashArg(text: string): { cmd: string } | undefined {
	if (!text.startsWith("bash ")) return undefined;
	const raw = text.slice(5).trim();
	if (!raw) return undefined;
	return { cmd: raw };
}

export function parseIntent(input: { text: string; channel: string; actor: string }): Intent {
	const text = input.text.trim();
	if (!text) return { kind: "help" };
	if (text === "help") return { kind: "help" };

	const bash = bashArg(text);
	if (bash) return { kind: "bash", ...bash, channel: input.channel, actor: input.actor };

	const approve = arg("approve", text);
	if (approve) return { kind: "approve", approvalId: approve, channel: input.channel, actor: input.actor };

	const deny = arg("deny", text);
	if (deny) return { kind: "deny", approvalId: deny, channel: input.channel, actor: input.actor };

	const cancel = arg("cancel", text);
	if (cancel) return { kind: "cancel", id: cancel, channel: input.channel, actor: input.actor };

	if (text === "status") return { kind: "thread_status", channel: input.channel, actor: input.actor };

	const status = arg("status", text);
	if (status) return { kind: "status", callId: status, channel: input.channel };

	return { kind: "ask", text, channel: input.channel, actor: input.actor };
}

export function normalizeText(text: string): string {
	return text.replace(/<@[^>]+>/g, "").trim();
}

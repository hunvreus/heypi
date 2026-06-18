import type { Logger } from "../core/log.js";

export function warnMissingChatAllow(input: {
	logger: Logger;
	adapter: string;
	kind: string;
	surface: "channel" | "group";
}): void {
	input.logger.warn("security.adapter_allow_missing", {
		adapter: input.adapter,
		kind: input.kind,
		reason: `without allow, delivered DMs and mentioned ${input.surface} messages can trigger the agent`,
	});
}

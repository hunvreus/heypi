import { describe, expectTypeOf, it } from "vitest";
import type {
	Adapter,
	AdapterApprovalConfig,
	AdapterEvents,
	AdapterKind,
	AdminConfig,
	AllowConfig,
	ApprovalExtensionOptions,
	ApprovalLayout,
	ApprovalRow,
	ApprovalState,
	AuditConversation,
	ChatJob,
	DiscordConfig,
	LoadAgentOptions,
	LocalConfig,
	RuntimeKind,
	SlackConfig,
	TelegramConfig,
	ToolConfig,
	ToolConfigMap,
} from "../src/index.js";
import { todoEvents } from "../src/index.js";

describe("public entrypoint", () => {
	it("exports config and approval integration types", () => {
		expectTypeOf<AdapterKind>().toEqualTypeOf<"slack" | "discord" | "telegram" | "webhook" | "local">();
		expectTypeOf<RuntimeKind>().toEqualTypeOf<
			"host" | "docker" | "gondolin" | "just-bash" | "vercel" | "cloudflare"
		>();
		expectTypeOf<ApprovalLayout>().toEqualTypeOf<"message" | "card">();
		expectTypeOf<ApprovalState>().toEqualTypeOf<"pending" | "approved" | "rejected">();
		expectTypeOf<AllowConfig>().toMatchTypeOf<{ dms?: boolean; channels?: string[]; users?: string[] }>();
		expectTypeOf<Adapter>().toMatchTypeOf<{ admins?: { users?: string[] }; approvers?: { users?: string[] } }>();
		expectTypeOf<Adapter>().toMatchTypeOf<{ events?: { "turn.started"?: unknown } }>();
		expectTypeOf<AdapterApprovalConfig>().toMatchTypeOf<{ layout?: ApprovalLayout; timeoutMs?: number }>();
		expectTypeOf<ChatJob["id"]>().toEqualTypeOf<string>();
		expectTypeOf<ChatJob["state"]>().toEqualTypeOf<"queued" | "running" | "completed" | "failed" | "canceled">();
		expectTypeOf<AdminConfig>().toMatchTypeOf<{ port?: number; token?: string }>();
		expectTypeOf<ToolConfig>().toMatchTypeOf<{ approve?: unknown }>();
		expectTypeOf<ToolConfigMap>().toMatchTypeOf<Record<string, unknown>>();
		expectTypeOf<LoadAgentOptions>().toMatchTypeOf<{ memory?: boolean; todo?: boolean }>();
		expectTypeOf<SlackConfig>().toMatchTypeOf<{ reaction?: false | string; status?: boolean }>();
		expectTypeOf<DiscordConfig>().toMatchTypeOf<{ typing?: boolean }>();
		expectTypeOf<TelegramConfig>().toMatchTypeOf<{ typing?: boolean }>();
		expectTypeOf<LocalConfig>().toMatchTypeOf<{ todo?: boolean }>();
		expectTypeOf<AuditConversation>().toMatchTypeOf<{ key: string; path: string }>();
		expectTypeOf<ApprovalRow>().toMatchTypeOf<{ label: string; value: string }>();
		expectTypeOf<ApprovalExtensionOptions>().toMatchTypeOf<{ request: unknown }>();
		expectTypeOf(todoEvents()).toMatchTypeOf<AdapterEvents>();
	});
});

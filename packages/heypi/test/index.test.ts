import { describe, expectTypeOf, it } from "vitest";
import type {
	Adapter,
	AdapterApprovalConfig,
	AdapterKind,
	AdminConfig,
	AllowConfig,
	ApprovalExtensionOptions,
	ApprovalLayout,
	ApprovalRow,
	ApprovalState,
	AuditConversation,
	ChatJob,
	LoadAgentOptions,
	RuntimeKind,
	ToolConfig,
	ToolConfigMap,
} from "../src/index.js";
import { statusEvents } from "../src/index.js";

describe("public entrypoint", () => {
	it("exports config and approval integration types", () => {
		expectTypeOf<AdapterKind>().toEqualTypeOf<"slack" | "discord" | "telegram" | "webhook" | "local">();
		expectTypeOf<RuntimeKind>().toEqualTypeOf<"host" | "docker">();
		expectTypeOf<ApprovalLayout>().toEqualTypeOf<"message" | "card">();
		expectTypeOf<ApprovalState>().toEqualTypeOf<"pending" | "approved" | "rejected">();
		expectTypeOf<AllowConfig>().toMatchTypeOf<{ users?: string[]; conversations?: string[] }>();
		expectTypeOf<Adapter>().toMatchTypeOf<{ admins?: { users?: string[] }; approvers?: { users?: string[] } }>();
		expectTypeOf<Adapter>().toMatchTypeOf<{ events?: { "turn.started"?: unknown } }>();
		expectTypeOf<AdapterApprovalConfig>().toMatchTypeOf<{ layout?: ApprovalLayout; timeoutMs?: number }>();
		expectTypeOf<ChatJob>().toMatchTypeOf<{ id: string; state: "queued" | "running" }>();
		expectTypeOf<AdminConfig>().toMatchTypeOf<{ port?: number; token?: string }>();
		expectTypeOf<ToolConfig>().toMatchTypeOf<{ approve?: unknown }>();
		expectTypeOf<ToolConfigMap>().toMatchTypeOf<Record<string, unknown>>();
		expectTypeOf<LoadAgentOptions>().toMatchTypeOf<{ memory?: boolean; todo?: boolean }>();
		expectTypeOf<AuditConversation>().toMatchTypeOf<{ key: string; path: string }>();
		expectTypeOf<ApprovalRow>().toMatchTypeOf<{ label: string; value: string }>();
		expectTypeOf<ApprovalExtensionOptions>().toMatchTypeOf<{ request: unknown }>();
		expectTypeOf(statusEvents()).toMatchTypeOf<{ "turn.started": unknown }>();
	});
});

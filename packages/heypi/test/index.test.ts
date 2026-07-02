import { describe, expectTypeOf, it } from "vitest";
import type {
	AdapterKind,
	AdminConfig,
	AgentFileConfig,
	ApprovalExtensionOptions,
	ApprovalLayout,
	ApprovalRow,
	ApprovalState,
	AuditChannel,
	ContextMode,
	RuntimeKind,
	TodoConfig,
} from "../src/index.js";

describe("public entrypoint", () => {
	it("exports config and approval integration types", () => {
		expectTypeOf<AdapterKind>().toEqualTypeOf<"slack" | "discord" | "telegram" | "webhook" | "local">();
		expectTypeOf<ContextMode>().toEqualTypeOf<"current" | "delta">();
		expectTypeOf<RuntimeKind>().toEqualTypeOf<"local">();
		expectTypeOf<ApprovalLayout>().toEqualTypeOf<"message" | "card">();
		expectTypeOf<ApprovalState>().toEqualTypeOf<"pending" | "approved" | "rejected">();
		expectTypeOf<AgentFileConfig>().toMatchTypeOf<{ context?: { mode?: ContextMode } }>();
		expectTypeOf<AdminConfig>().toMatchTypeOf<{ enabled?: boolean; port?: number }>();
		expectTypeOf<TodoConfig>().toMatchTypeOf<{ enabled?: boolean }>();
		expectTypeOf<AuditChannel>().toMatchTypeOf<{ key: string; path: string }>();
		expectTypeOf<ApprovalRow>().toMatchTypeOf<{ label: string; value: string }>();
		expectTypeOf<ApprovalExtensionOptions>().toMatchTypeOf<{ request: unknown }>();
	});
});

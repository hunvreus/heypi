import { describe, expectTypeOf, it } from "vitest";
import type {
	AdapterApprovalConfig,
	AdapterKind,
	AdminConfig,
	AllowConfig,
	ApprovalExtensionOptions,
	ApprovalLayout,
	ApprovalRow,
	ApprovalState,
	AuditChannel,
	RuntimeKind,
	ToolConfig,
	ToolConfigMap,
} from "../src/index.js";

describe("public entrypoint", () => {
	it("exports config and approval integration types", () => {
		expectTypeOf<AdapterKind>().toEqualTypeOf<"slack" | "discord" | "telegram" | "webhook" | "local">();
		expectTypeOf<RuntimeKind>().toEqualTypeOf<"host" | "docker">();
		expectTypeOf<ApprovalLayout>().toEqualTypeOf<"message" | "card">();
		expectTypeOf<ApprovalState>().toEqualTypeOf<"pending" | "approved" | "rejected">();
		expectTypeOf<AllowConfig>().toMatchTypeOf<{ users?: string[]; conversations?: string[] }>();
		expectTypeOf<AdapterApprovalConfig>().toMatchTypeOf<{ approvers?: { users?: string[] } }>();
		expectTypeOf<AdminConfig>().toMatchTypeOf<{ port?: number }>();
		expectTypeOf<ToolConfig>().toMatchTypeOf<{ approve?: unknown }>();
		expectTypeOf<ToolConfigMap>().toMatchTypeOf<Record<string, unknown>>();
		expectTypeOf<AuditChannel>().toMatchTypeOf<{ key: string; path: string }>();
		expectTypeOf<ApprovalRow>().toMatchTypeOf<{ label: string; value: string }>();
		expectTypeOf<ApprovalExtensionOptions>().toMatchTypeOf<{ request: unknown }>();
	});
});

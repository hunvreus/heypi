import { afterEach, describe, expect, it, vi } from "vitest";
import { consoleLogger } from "../src/log.js";

describe("consoleLogger", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("preserves structured data as JSON", () => {
		const info = vi.spyOn(console, "info").mockImplementation(() => undefined);

		consoleLogger.info("turn_started", { adapter: "slack", context: { conversation: "C123" } });

		expect(info).toHaveBeenCalledOnce();
		expect(info.mock.calls[0]?.[0]).toContain("[heypi] turn_started");
		expect(info.mock.calls[0]?.[0]).toContain('{"adapter":"slack","context":{"conversation":"C123"}}');
	});

	it("prints the ready summary", () => {
		const info = vi.spyOn(console, "info").mockImplementation(() => undefined);

		consoleLogger.ready?.({
			agent: "codex-tag",
			admin: "http://127.0.0.1:4321/admin",
			adapters: ["local", "slack"],
		});

		expect(info).toHaveBeenCalledOnce();
		expect(info.mock.calls[0]?.[0]).toContain("[heypi] ready");
		expect(info.mock.calls[0]?.[0]).toContain("Agent: codex-tag");
		expect(info.mock.calls[0]?.[0]).toContain("Adapters: local, slack");
	});
});

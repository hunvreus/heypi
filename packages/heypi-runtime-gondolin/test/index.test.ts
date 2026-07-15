import { describe, expect, it } from "vitest";
import { gondolin } from "../src/index.js";

describe("Gondolin runtime", () => {
	it("declares an isolated provider without starting a VM", () => {
		const runtime = gondolin({ workspace: "./workspace", memory: "2G" });

		expect(runtime.kind).toBe("gondolin");
		expect(runtime.workspace).toBe("./workspace");
		expect(runtime.provider).toBeTypeOf("function");
	});
});

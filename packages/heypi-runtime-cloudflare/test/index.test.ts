import { describe, expect, it } from "vitest";
import { cloudflare } from "../src/index.js";

describe("Cloudflare runtime", () => {
	it("declares a provider around a caller-owned sandbox", () => {
		const sandbox = async () => {
			throw new Error("not started");
		};
		const runtime = cloudflare({ workspace: "./workspace", sandbox });
		expect(runtime).toMatchObject({ kind: "cloudflare", workspace: "./workspace" });
		expect(runtime.provider).toBeTypeOf("function");
	});
});

import { describe, expect, it } from "vitest";
import { vercel } from "../src/index.js";

describe("Vercel runtime", () => {
	it("declares a remote provider without creating a sandbox", () => {
		const runtime = vercel({ workspace: "./workspace" });
		expect(runtime).toMatchObject({ kind: "vercel", workspace: "./workspace" });
		expect(runtime.provider).toBeTypeOf("function");
	});
});

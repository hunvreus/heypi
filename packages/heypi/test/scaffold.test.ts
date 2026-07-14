import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { listTemplates, scaffold } from "../src/scaffold.js";

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "heypi-scaffold-"));
	temporaryDirectories.push(directory);
	return directory;
}

afterEach(async () => {
	await Promise.all(
		temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
	);
});

describe("scaffold", () => {
	it("lists templates and copies one atomically", async () => {
		const root = await temporaryDirectory();
		const templates = join(root, "templates");
		await mkdir(join(templates, "zeta"), { recursive: true });
		await mkdir(join(templates, "alpha", "agent"), { recursive: true });
		await writeFile(join(templates, "alpha", ".env.example"), "TOKEN=\n");
		await writeFile(join(templates, "alpha", "agent", "system.md"), "Be useful.\n");

		expect(await listTemplates(templates)).toEqual(["alpha", "zeta"]);
		const destination = join(root, "project");
		expect(await scaffold({ templatesDir: templates, template: "alpha", destination })).toBe(destination);
		expect(await readFile(join(destination, ".env.example"), "utf8")).toBe("TOKEN=\n");
		expect(await readFile(join(destination, "agent", "system.md"), "utf8")).toBe("Be useful.\n");
	});

	it("rejects unknown templates and existing destinations", async () => {
		const root = await temporaryDirectory();
		const templates = join(root, "templates");
		await mkdir(join(templates, "known"), { recursive: true });

		await expect(
			scaffold({ templatesDir: templates, template: "../unknown", destination: join(root, "unknown") }),
		).rejects.toThrow('Unknown template "../unknown"');

		const destination = join(root, "existing");
		await mkdir(destination);
		await expect(scaffold({ templatesDir: templates, template: "known", destination })).rejects.toThrow(
			"Destination already exists",
		);
	});

	it("keeps codex-tag standalone and aligned with the package version", async () => {
		const workspace = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
		const templatePackage = JSON.parse(await readFile(join(workspace, "examples/codex-tag/package.json"), "utf8"));
		const heypiPackage = JSON.parse(await readFile(join(workspace, "packages/heypi/package.json"), "utf8"));
		const tsconfig = JSON.parse(await readFile(join(workspace, "examples/codex-tag/tsconfig.json"), "utf8"));

		expect(templatePackage.dependencies["@hunvreus/heypi"]).toBe(`^${heypiPackage.version}`);
		expect(JSON.stringify(templatePackage.scripts)).not.toContain("../..");
		expect(tsconfig.extends).toBeUndefined();
	});
});

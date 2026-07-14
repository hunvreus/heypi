import { execFileSync } from "node:child_process";
import { copyFile, mkdir, readFile, rm } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const workspaceDir = resolve(packageDir, "../..");
const examplesDir = join(workspaceDir, "examples");
const outputDir = join(packageDir, "dist", "templates");
const packageJson = JSON.parse(await readFile(join(packageDir, "package.json"), "utf8"));
const expectedDependency = `^${packageJson.version}`;

const tracked = execFileSync("git", ["ls-files", "-z", "--", "examples"], {
	cwd: workspaceDir,
	encoding: "utf8",
})
	.split("\0")
	.filter(Boolean);

const templates = new Set();
for (const file of tracked) {
	const parts = file.split("/");
	if (parts.length < 3 || parts[0] !== "examples") continue;
	templates.add(parts[1]);
}

await rm(outputDir, { recursive: true, force: true });
for (const template of [...templates].sort()) {
	const sourcePackagePath = join(examplesDir, template, "package.json");
	const sourcePackage = JSON.parse(await readFile(sourcePackagePath, "utf8"));
	if (sourcePackage.dependencies?.["@hunvreus/heypi"] !== expectedDependency) {
		throw new Error(
			`examples/${template} must depend on @hunvreus/heypi ${expectedDependency} to be published as a template`,
		);
	}
}

for (const file of tracked) {
	const source = join(workspaceDir, file);
	const templatePath = relative("examples", file);
	if (templatePath.startsWith(`..${sep}`) || templatePath === "..") continue;
	const destination = join(outputDir, templatePath);
	await mkdir(dirname(destination), { recursive: true });
	await copyFile(source, destination);
}

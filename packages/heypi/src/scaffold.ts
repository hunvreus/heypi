import { cp, mkdir, mkdtemp, readdir, rename, rm, stat } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

export type ScaffoldOptions = {
	templatesDir: string;
	template: string;
	destination: string;
};

/** Lists bundled template directory names in deterministic order. */
export async function listTemplates(templatesDir: string): Promise<string[]> {
	const entries = await readdir(templatesDir, { withFileTypes: true });
	return entries
		.filter((entry) => entry.isDirectory())
		.map((entry) => entry.name)
		.sort((a, b) => a.localeCompare(b));
}

/** Copies one bundled template atomically into a new destination directory. */
export async function scaffold(options: ScaffoldOptions): Promise<string> {
	const templatesDir = resolve(options.templatesDir);
	const templates = await listTemplates(templatesDir);
	if (!templates.includes(options.template)) {
		throw new Error(
			`Unknown template "${options.template}". Available templates: ${templates.join(", ") || "none"}.`,
		);
	}

	const destination = resolve(options.destination);
	try {
		await stat(destination);
		throw new Error(`Destination already exists: ${destination}`);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}

	const parent = dirname(destination);
	await mkdir(parent, { recursive: true });
	const temporary = await mkdtemp(join(parent, `.${basename(destination)}-heypi-`));
	try {
		const source = join(templatesDir, options.template);
		for (const entry of await readdir(source)) {
			await cp(join(source, entry), join(temporary, entry), { recursive: true });
		}
		await rename(temporary, destination);
		return destination;
	} catch (error) {
		await rm(temporary, { recursive: true, force: true });
		throw error;
	}
}

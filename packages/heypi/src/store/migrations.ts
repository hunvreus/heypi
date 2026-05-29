import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export type Migration = {
	name: string;
	content: string;
};

export const MIGRATIONS: Migration[] = loadMigrations();

function loadMigrations(): Migration[] {
	const base = dirname(fileURLToPath(import.meta.url));
	const dir = [join(base, "..", "drizzle"), join(base, "..", "..", "drizzle")].find((item) => existsSync(item));
	if (!dir) throw new Error("heypi migrations directory not found");
	const migrations = readdirSync(dir)
		.filter((name) => /^\d{4}_.+\.sql$/u.test(name))
		.sort()
		.map((name) => ({
			name,
			content: readFileSync(join(dir, name), "utf8"),
		}));
	if (migrations.length === 0) throw new Error(`no heypi migrations found in ${dir}`);
	return migrations;
}

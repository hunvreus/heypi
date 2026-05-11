import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { sql } from "drizzle-orm";
import type { Db } from "./db.js";

export async function migrate(db: Db): Promise<void> {
	for (const file of files()) {
		const content = readFileSync(file, "utf8");
		const parts = content
			.split("--> statement-breakpoint")
			.map((v) => v.trim())
			.filter(Boolean);
		for (const stmt of parts) await execute(db, stmt);
	}
}

function files(): string[] {
	const dir = migrationDir();
	return readdirSync(dir)
		.filter((name) => name.endsWith(".sql"))
		.sort()
		.map((name) => join(dir, name));
}

function migrationDir(): string {
	const here = dirname(fileURLToPath(import.meta.url));
	const candidates = [resolve(process.cwd(), "drizzle"), resolve(here, "../drizzle"), resolve(here, "../../drizzle")];
	for (const dir of candidates) {
		try {
			if (readdirSync(dir).some((name) => name.endsWith(".sql"))) return dir;
		} catch {
			// Try the next package/source layout.
		}
	}
	throw new Error("No heypi migrations found");
}

async function execute(db: Db, stmt: string): Promise<void> {
	try {
		await db.run(sql.raw(stmt));
	} catch (error) {
		const msg = error instanceof Error ? error.message : String(error);
		if (msg.includes("already exists")) return;
		throw error;
	}
}

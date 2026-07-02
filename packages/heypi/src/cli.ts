#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { join } from "node:path";

const command = process.argv[2] ?? "help";

if (command === "version" || command === "--version" || command === "-v") {
	const pkg = JSON.parse(readFileSync(join(import.meta.dirname, "../package.json"), "utf8")) as { version: string };
	process.stdout.write(`${pkg.version}\n`);
} else {
	process.stdout.write("heypi pi-native rewrite CLI is intentionally minimal in this branch.\n");
	process.stdout.write("Use loadAgent() and runHeypi() from @hunvreus/heypi.\n");
}

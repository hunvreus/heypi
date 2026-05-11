import { defineConfig } from "drizzle-kit";

export default defineConfig({
	dialect: "sqlite",
	schema: "./src/db/schema.ts",
	out: "./drizzle",
	dbCredentials: {
		url: process.env.HEYPI_DB_PATH || "./heypi.db",
	},
	strict: true,
	verbose: true,
});

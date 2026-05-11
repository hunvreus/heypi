import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";

export function openDb(input: { url: string; authToken?: string }) {
	const client = createClient({ url: input.url, authToken: input.authToken });
	return drizzle(client);
}

export type Db = ReturnType<typeof openDb>;

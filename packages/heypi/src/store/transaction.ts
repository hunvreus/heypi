import type { Store } from "./types.js";

/** Runs a store operation inside a transaction when the store supports one. */
export async function transaction<T>(store: Store, fn: (store: Store) => Promise<T>): Promise<T> {
	return store.transaction ? store.transaction(fn) : fn(store);
}

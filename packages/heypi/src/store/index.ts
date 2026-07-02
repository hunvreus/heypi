export type Store = {
	close?(): Promise<void> | void;
};

export function sqliteStore(): Store {
	return {};
}

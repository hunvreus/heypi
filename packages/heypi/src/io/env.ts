export function requiredEnv(name: string, label: string): string {
	const value = optionalEnv(name);
	if (!value) throw new Error(`${label} is required; pass it explicitly or set ${name}`);
	return value;
}

export function optionalEnv(name: string): string | undefined {
	const value = process.env[name]?.trim();
	return value || undefined;
}

export function match(value: string, pattern?: string): boolean {
	if (!pattern || pattern === "*" || pattern === "**/*") return true;
	const escaped = pattern
		.replace(/[.+^${}()|[\]\\]/g, "\\$&")
		.replace(/\*\*/g, "::STAR::")
		.replace(/\*/g, "[^/]*")
		.replace(/::STAR::/g, ".*");
	return new RegExp(`^${escaped}$`).test(value) || value.includes(pattern);
}

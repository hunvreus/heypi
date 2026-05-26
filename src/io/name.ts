const ROUTE_NAME_RE = /^[a-z0-9][a-z0-9-]{0,38}$/;

/** Validates names that become public HTTP route segments. */
export function assertRouteName(name: string, label = "adapter name"): void {
	if (!ROUTE_NAME_RE.test(name)) {
		throw new Error(`${label} must match ${ROUTE_NAME_RE}: ${name}`);
	}
}

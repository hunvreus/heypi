export type RuntimeScope = {
	path: string;
	root?: string;
};

export type RuntimeStatus = {
	name: string;
	scope?: string;
	status: "idle" | "starting" | "running" | "stopped" | "error";
	message?: string;
};

export class RuntimeStartupError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "RuntimeStartupError";
	}
}

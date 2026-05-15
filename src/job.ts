export type JobKind = "cron" | "heartbeat";
export type JobState = "active" | "paused";

export type JobSchedule =
	| { at: string | number | Date }
	| { everyMs: number; anchorMs?: number }
	| { cron: string; timezone?: string };

export type JobScope = {
	adapters?: string[];
	teams?: string[];
	channels?: string[];
	users?: string[];
};

export type JobTarget = {
	adapter?: string;
	channel?: string;
	user?: string;
	thread?: string;
	mode?: "channel" | "thread" | "dm";
};

export type JobConfig = {
	id: string;
	kind?: JobKind;
	schedule?: JobSchedule;
	everyMs?: number;
	idleMs?: number;
	scope?: JobScope;
	target?: JobTarget;
	prompt: string;
	state?: JobState;
};

export type JobKind = "cron" | "heartbeat";
export type JobState = "active" | "paused";

export type JobSchedule =
	| { at: string | number | Date }
	| { everyMs: number; anchorMs?: number }
	| { cron: string; timezone?: string };

export type JobRoute = {
	channels?: string[];
	users?: string[];
};

export type JobTarget = JobRoute;

export type JobScope = Record<string, JobRoute>;

export type JobTargets = JobScope;

export type JobConfig = {
	id: string;
	kind?: JobKind;
	schedule?: JobSchedule;
	everyMs?: number;
	idleMs?: number;
	scope?: JobScope;
	targets?: JobTargets;
	prompt: string;
	state?: JobState;
};

/** Defines a scheduled heypi job. */
export function defineJob(input: JobConfig): JobConfig {
	return input;
}

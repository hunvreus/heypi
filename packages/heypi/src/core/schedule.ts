import { Cron } from "croner";
import type { JobSchedule } from "../job.js";

const crons = new Map<string, Cron>();

export function nextAt(schedule: JobSchedule, now = Date.now(), previous?: number | null): number | undefined {
	if ("at" in schedule) {
		const at = atMs(schedule.at);
		return at > now ? at : undefined;
	}
	if ("everyMs" in schedule) {
		const every = Math.max(1, Math.floor(schedule.everyMs));
		const anchor = Math.max(0, Math.floor(previous ?? schedule.anchorMs ?? now));
		let next = anchor + every;
		while (next <= now) next += every;
		return next;
	}
	const expr = schedule.cron.trim();
	if (!expr) return undefined;
	const next = cron(expr, schedule.timezone).nextRun(new Date(now));
	const ms = next?.getTime();
	return ms && Number.isFinite(ms) && ms > now ? ms : undefined;
}

function cron(expr: string, timezone?: string): Cron {
	const key = `${timezone ?? ""}\n${expr}`;
	const existing = crons.get(key);
	if (existing) return existing;
	const created = new Cron(expr, { timezone, catch: false });
	crons.set(key, created);
	return created;
}

function atMs(input: string | number | Date): number {
	if (typeof input === "number") return input;
	if (input instanceof Date) return input.getTime();
	const ms = Date.parse(input);
	if (!Number.isFinite(ms)) throw new Error(`invalid job time: ${input}`);
	return ms;
}

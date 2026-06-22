import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, rm, stat, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { consoleLogger, createHeypi, type Logger, loadAgent, sqliteStore, workspace } from "@hunvreus/heypi";
import type { Adapter } from "@hunvreus/heypi/adapter";
import {
	adminLoginUrl,
	createAdminLoginToken,
	readAdminSecret,
	readAdminServerDescriptors,
	verifyAdminLoginToken,
} from "../src/admin/auth.js";
import { createAdminService } from "../src/admin/service.js";
import {
	approvalsView,
	configurationView,
	evalsView,
	jobsView,
	memoryView,
	page,
	threadsView,
} from "../src/admin/view.js";
import type { AdapterStart } from "../src/io/handler.js";

type LogEntry = {
	event: string;
	input?: Record<string, unknown>;
};

test("admin tables preserve pagination and filter state", () => {
	const now = Date.now();
	const body = jobsView({
		limit: 50,
		offset: 50,
		hasNext: true,
		filters: { q: "daily", type: "cron" },
		rows: [
			{
				id: "daily",
				agent: "default",
				kind: "cron",
				schedule: "FREQ=DAILY",
				scope: null,
				target: null,
				prompt: "Check in",
				state: "active",
				nextAt: now,
				lastAt: null,
				idleMs: null,
				createdAt: now,
				updatedAt: now,
				lastRun: null,
			},
		],
	} satisfies Parameters<typeof jobsView>[0]);
	assert.match(body, /aria-label="pagination"/);
	assert.match(body, /data-admin-filter-form/);
	assert.match(body, /name="q"[^>]+value="daily"[^>]+data-admin-filter-search/);
	assert.match(body, /name="type"[^>]+data-admin-filter-select="type"/);
	assert.match(body, /type="submit"[^>]+data-admin-filter-submit/);
	assert.match(body, /href="\/admin\/jobs"[^>]+data-admin-filter-reset/);
	assert.match(body, /<option value="cron" selected>Cron<\/option>/);
	assert.match(body, /href="\/admin\/jobs\?limit=50&amp;offset=100&amp;q=daily&amp;type=cron"/);
	assert.doesNotMatch(body, /Rows 51-51/);
});

test("admin jobs page labels future next runs as upcoming", () => {
	const realNow = Date.now;
	Date.now = () => 1_700_000_000_000;
	try {
		const body = jobsView({
			limit: 25,
			offset: 0,
			hasNext: false,
			rows: [
				{
					id: "daily",
					agent: "default",
					kind: "cron",
					schedule: "FREQ=DAILY",
					scope: null,
					target: null,
					prompt: "Check in",
					state: "active",
					nextAt: Date.now() + 60_000,
					lastAt: Date.now() - 120_000,
					idleMs: null,
					createdAt: Date.now(),
					updatedAt: Date.now(),
					lastRun: null,
				},
			],
		});
		assert.match(body, /in 1m 0s/);
		assert.match(body, /2m 0s ago/);
		assert.doesNotMatch(body, /0ms ago/);
	} finally {
		Date.now = realNow;
	}
});

test("admin evals page renders loaded eval definitions", () => {
	const body = evalsView({
		limit: 25,
		offset: 0,
		hasNext: false,
		filters: { q: "deploy" },
		rows: [
			{
				name: "deploy smoke",
				prompt: "Can I deploy prod?",
				tags: ["smoke", "approval"],
				timeoutMs: 30_000,
				expect: "approval:true",
				expectDetail: "approval:true\nincludes:deploy",
			},
		],
	});
	assert.match(body, /Evals/);
	assert.match(body, /Loaded agent behavior eval definitions/);
	assert.match(body, /deploy smoke/);
	assert.match(body, /smoke, approval/);
	assert.match(body, /approval:true/);
	assert.match(body, /30s/);
	assert.match(body, /data-admin-eval-details="deploy smoke"/);
	assert.match(body, /Eval details/);
	assert.match(body, /approval:true\nincludes:deploy/);
	assert.match(body, /Can I deploy prod\?/);
	assert.match(body, /name="q"[^>]+value="deploy"[^>]+data-admin-filter-search/);
	assert.match(body, /href="\/admin\/evals"[^>]+data-admin-filter-reset/);
});

test("admin jobs page renders explicit targets and scoped heartbeat routes", async () => {
	const root = await mkdtemp(join(tmpdir(), "heypi-admin-jobs-routes-"));
	const port = await freePort();
	const adapter: Adapter = {
		name: "slack",
		kind: "slack",
		start: async () => undefined,
		send: async () => undefined,
		stop: async () => undefined,
	};
	const app = createHeypi({
		store: sqliteStore({ path: join(root, "heypi.db") }),
		state: { root: stateRoot(root) },
		logger: captureLogger([]),
		http: { port },
		admin: { auth: false, http: { port } },
		adapters: [adapter],
		agent: loadAgent("../../examples/slack-devops/agent", { id: "default", model: "openai/gpt-5-mini" }),
		runtime: { name: "host-bash", root: workspace(join(root, "workspace")) },
		jobs: [
			{
				id: "daily",
				kind: "cron",
				schedule: { at: Date.now() + 60_000 },
				targets: { slack: { channels: ["C123"], users: ["U123"] } },
				prompt: "Daily check",
			},
			{
				id: "idle",
				kind: "heartbeat",
				everyMs: 60_000,
				idleMs: 30_000,
				scope: { slack: { channels: ["C123"] } },
				prompt: "Idle check",
			},
		],
	});
	try {
		await app.start();
		const response = await fetch(`http://127.0.0.1:${port}/admin/jobs`);
		assert.equal(response.status, 200);
		const body = await response.text();
		assert.match(body, /targets: slack channel C123, slack user U123/);
		assert.match(body, /scope: slack channel C123/);
		assert.match(body, /data-admin-column="Route"/);
		assert.doesNotMatch(body, /"channels":\["C123"\]/);

		const filtered = await fetch(`http://127.0.0.1:${port}/admin/jobs?q=Daily&type=cron`);
		assert.equal(filtered.status, 200);
		const filteredBody = await filtered.text();
		assert.match(filteredBody, /Daily check/);
		assert.doesNotMatch(filteredBody, /Idle check/);
		assert.match(filteredBody, /value="Daily"/);
		assert.match(filteredBody, /<option value="cron" selected>Cron<\/option>/);
	} finally {
		await app.stop();
		await rm(root, { recursive: true, force: true });
	}
});

test("admin filtered jobs report incomplete scans", async () => {
	const root = await mkdtemp(join(tmpdir(), "heypi-admin-filter-truncated-"));
	try {
		const store = sqliteStore({ path: join(root, "heypi.db") });
		await store.setup();
		const now = Date.now();
		for (let index = 0; index < 501; index++) {
			await store.jobs?.upsert({
				id: index === 500 ? "zzzz-target" : `job-${String(index).padStart(3, "0")}`,
				agent: "default",
				kind: "cron",
				schedule: JSON.stringify({ everyMs: 60_000 }),
				target: JSON.stringify({ slack: { channels: ["C123"] } }),
				prompt: index === 500 ? "hidden match" : "routine",
				state: "active",
				nextAt: now + 60_000,
			});
		}
		const service = createAdminService({
			store,
			handler: async () => undefined,
			logger: consoleLogger({ level: "error", format: "pretty" }),
			app: {
				agent: "default",
				runtime: { name: "host-bash", root: join(root, "workspace") },
				state: { root: stateRoot(root) },
				memory: { enabled: false, scope: "agent", writePolicy: "off", maxChars: 4000 },
				adapters: [],
				startedAt: now,
			},
		} as AdapterStart);

		const page = await service.jobs({ q: "hidden", limit: 25 });
		assert.equal(page.truncated, true);
		assert.deepEqual(page.rows, []);
		assert.match(jobsView(page), /Filtered results may be incomplete/);

		const invalidPage = await service.jobs({ limit: Number.NaN, offset: Number.NaN });
		assert.equal(invalidPage.limit, 25);
		assert.equal(invalidPage.offset, 0);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("admin service lists loaded eval definitions", async () => {
	const root = await mkdtemp(join(tmpdir(), "heypi-admin-evals-"));
	try {
		const store = sqliteStore({ path: join(root, "heypi.db") });
		await store.setup();
		const now = Date.now();
		const service = createAdminService({
			store,
			handler: async () => undefined,
			logger: consoleLogger({ level: "error", format: "pretty" }),
			app: {
				agent: "default",
				runtime: { name: "host-bash", root: join(root, "workspace") },
				state: { root: stateRoot(root) },
				memory: { enabled: false, scope: "agent", writePolicy: "off", maxChars: 4000 },
				adapters: [],
				evals: [
					{
						name: "deploy approval",
						tags: ["approval"],
						prompt: "Deploy production",
						expect: { approval: true },
						timeoutMs: 45_000,
					},
					{
						name: "host list",
						tags: ["smoke"],
						prompt: "List hosts",
						expect: [{ tool: "hosts_list" }, { includes: "prod" }],
					},
				],
				startedAt: now,
			},
		} as AdapterStart);

		const page = await service.evals({ q: "approval" });
		assert.equal(page.rows.length, 1);
		assert.equal(page.rows[0]?.name, "deploy approval");
		assert.equal(page.rows[0]?.expect, "approval:true");
		assert.equal(page.rows[0]?.expectDetail, "approval:true");
		assert.equal(page.rows[0]?.timeoutMs, 45_000);

		const all = await service.evals();
		assert.deepEqual(
			all.rows.map((row) => row.name),
			["deploy approval", "host list"],
		);
		assert.equal(all.rows[1]?.expect, "tool:hosts_list, includes:prod");
		assert.equal(all.rows[1]?.expectDetail, "1. tool:hosts_list\n2. includes:prod");
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("admin service scopes approvals and calls to the current agent", async () => {
	const root = await mkdtemp(join(tmpdir(), "heypi-admin-agent-scope-"));
	try {
		const store = sqliteStore({ path: join(root, "heypi.db") });
		await store.setup();
		const now = Date.now();
		const ownThread = await store.threads.getOrCreate({
			agent: "default",
			provider: "slack",
			team: "T1",
			channel: "slack:T1:C1",
			actor: "U1",
			key: "C1",
		});
		const otherThread = await store.threads.getOrCreate({
			agent: "other",
			provider: "slack",
			team: "T1",
			channel: "slack:T1:C2",
			actor: "U2",
			key: "C2",
		});
		const localThread = await store.threads.getOrCreate({
			agent: "default",
			provider: "local",
			channel: "admin:local",
			actor: "operator",
			key: "admin:local",
		});
		const inputMessage = await store.messages.create({
			threadId: ownThread.id,
			provider: "slack",
			kind: "slack",
			role: "user",
			actor: "U1",
			text: "please deploy default",
			createdAt: now - 2000,
		});
		const ownTurn = await store.turns.create({
			threadId: ownThread.id,
			inputMessageId: inputMessage.id,
			agent: "default",
			provider: "slack",
			kind: "slack",
			channel: ownThread.channel,
			actor: "U1",
			trace: "trace-default",
		});
		const traceEvent = await store.events?.append({
			agent: "default",
			trace: "trace-default",
			threadId: ownThread.id,
			turnId: ownTurn.id,
			type: "turn.started",
			data: { intent: "ask" },
			createdAt: now - 1500,
		});
		assert.ok(traceEvent);
		const modelEvent = await store.events?.append({
			agent: "default",
			trace: "trace-default",
			threadId: ownThread.id,
			turnId: ownTurn.id,
			type: "model.completed",
			data: { mode: "prompt", chars: 18, tools: ["bash", "read"] },
			createdAt: now - 1200,
		});
		assert.ok(modelEvent);
		const evalEvent = await store.events?.append({
			agent: "default",
			trace: "trace-default",
			threadId: ownThread.id,
			turnId: ownTurn.id,
			type: "eval.completed",
			data: { eval: "smoke", assertions: [{ label: "includes", ok: true }] },
			createdAt: now - 1100,
		});
		assert.ok(evalEvent);
		const resultMessage = await store.messages.create({
			threadId: ownThread.id,
			provider: "slack",
			kind: "slack",
			role: "assistant",
			actor: "heypi",
			text: "deployment started",
			createdAt: now - 1000,
		});
		await store.turns.finish(ownTurn.id, { state: "done", resultMessageId: resultMessage.id });
		const otherMessage = await store.messages.create({
			threadId: otherThread.id,
			provider: "slack",
			kind: "slack",
			role: "user",
			actor: "U2",
			text: "deploy other",
			createdAt: now - 500,
		});
		const ownCall = await store.calls.create({
			agent: "default",
			threadId: ownThread.id,
			turnId: ownTurn.id,
			messageId: inputMessage.id,
			channel: "slack:T1:C1",
			actor: "U1",
			tool: "bash",
			command: "deploy default",
			state: "pending_approval",
		});
		const otherCall = await store.calls.create({
			agent: "other",
			channel: "slack:T1:C2",
			actor: "U2",
			tool: "bash",
			command: "deploy other",
			state: "pending_approval",
		});
		const ownApproval = await store.approvals.create({
			agent: "default",
			callId: ownCall.id,
			channel: ownCall.channel,
			threadId: ownThread.id,
			turnId: ownTurn.id,
			requestMessageId: inputMessage.id,
			command: "deploy default",
			runtime: "host-bash",
			reason: "Default approval",
		});
		const otherApproval = await store.approvals.create({
			agent: "other",
			callId: otherCall.id,
			channel: otherCall.channel,
			command: "deploy other",
			runtime: "host-bash",
			reason: "Other approval",
		});
		const bypass = await store.approvalBypasses?.create({
			agent: "default",
			scope: "thread",
			channel: "slack:T1:C1",
			threadId: ownThread.id,
			actor: "U1",
			createdBy: "U_ADMIN",
			reason: "Default approval",
			approvalId: ownApproval.id,
			expiresAt: now + 60_000,
		});
		assert.ok(bypass);
		const service = createAdminService({
			store,
			handler: async () => undefined,
			logger: consoleLogger({ level: "error", format: "pretty" }),
			app: {
				agent: "default",
				runtime: { name: "host-bash", root: join(root, "workspace") },
				state: { root: stateRoot(root) },
				approval: {
					expiresInMs: 120_000,
					allowSelfApproval: false,
					bypass: { scope: "channel", durationMs: 60_000 },
				},
				memory: { enabled: false, scope: "agent", writePolicy: "off", maxChars: 4000 },
				adapters: [
					{
						name: "ops",
						kind: "slack",
						permissions: { approvers: ["U_APPROVER"], admins: ["U_ADMIN"] },
					},
				],
				startedAt: now,
			},
		} as AdapterStart);

		const live = await service.live();
		assert.equal(live.pendingApprovals, 1);
		assert.equal(live.recentCalls, 1);
		const ownThreadRevision = live.threadRevisions[ownThread.id];
		assert.ok(ownThreadRevision);

		const approvals = await service.approvals();
		assert.deepEqual(
			approvals.rows.map((row) => row.id),
			[ownApproval.id],
		);
		const overview = await service.overview();
		assert.equal(overview.approval?.allowSelfApproval, false);
		const admins = overview.adapters[0]?.permissions?.admins;
		assert.ok(Array.isArray(admins));
		assert.equal(admins[0], "U_ADMIN");
		assert.deepEqual(
			overview.activeBypasses.map((row) => row.id),
			[bypass.id],
		);
		await store.approvalBypasses?.revoke(bypass.id, "U_ADMIN", { agent: "default" });
		const afterBypassRevoke = await service.live();
		assert.notEqual(afterBypassRevoke.revision, live.revision);

		const threads = await service.threads();
		assert.deepEqual(threads.rows.map((row) => row.id).sort(), [localThread.id, ownThread.id].sort());
		assert.deepEqual(threads.facets?.providers, ["local", "slack"]);
		const slackThreads = await service.threads({ provider: "slack" });
		assert.deepEqual(
			slackThreads.rows.map((row) => row.id),
			[ownThread.id],
		);
		assert.equal(slackThreads.rows[0]?.summary, "deployment started");
		assert.equal(slackThreads.rows[0]?.runningRuns, 0);
		const thread = await service.thread(ownThread.id, { event: `message:${inputMessage.id}` });
		assert.equal(thread?.selected?.id, inputMessage.id);
		const timeline = new Set(thread?.timeline.map((row) => `${row.kind}:${row.id}`));
		assert.equal(timeline.has(`message:${resultMessage.id}`), true);
		assert.equal(timeline.has(`run:${ownTurn.id}`), true);
		assert.equal(timeline.has(`message:${inputMessage.id}`), true);
		assert.equal(timeline.has(`approval:${ownApproval.id}`), true);
		assert.equal(timeline.has(`call:${ownCall.id}`), true);
		assert.equal(timeline.has(`event:${traceEvent.id}`), true);
		assert.equal(timeline.has(`event:${modelEvent.id}`), true);
		assert.equal(timeline.has(`event:${evalEvent.id}`), true);
		assert.equal(timeline.has(`approval:${otherApproval.id}`), false);
		assert.equal(timeline.has(`call:${otherCall.id}`), false);
		assert.equal(timeline.has(`message:${otherMessage.id}`), false);
		const run = thread?.timeline.find((row) => row.id === ownTurn.id);
		assert.equal(run?.title, "please deploy default");
		assert.equal(run?.summary, "deployment started");
		assert.equal(run?.provider, "slack");
		assert.equal(run?.eventType, "slack");
		assert.deepEqual(
			run?.details?.map((row) => row.label),
			["Trace", "Thread", "Input message", "Input", "Result message", "Result"],
		);
		const message = thread?.timeline.find((row) => row.id === inputMessage.id);
		assert.equal(message?.kind, "message");
		assert.equal(message?.title, "please deploy default");
		assert.equal(message?.provider, "slack");
		assert.equal(message?.eventType, "slack");
		assert.equal(message?.role, "user");
		const event = thread?.timeline.find((row) => row.id === traceEvent.id);
		assert.equal(event?.kind, "event");
		assert.equal(event?.title, "turn.started");
		assert.equal(event?.trace, "trace-default");
		assert.deepEqual(
			event?.details?.map((row) => row.label),
			["Trace", "Sequence", "Turn", "Data"],
		);
		const model = thread?.timeline.find((row) => row.id === modelEvent.id);
		assert.equal(model?.kind, "event");
		assert.equal(model?.title, "Model completed");
		assert.equal(model?.eventType, "model.completed");
		assert.equal(model?.summary, "prompt / 18 chars / 2 tools");
		assert.deepEqual(
			model?.details?.map((row) => row.label),
			["Trace", "Sequence", "Turn", "Mode", "Characters", "Tools", "Data"],
		);
		const evalRow = thread?.timeline.find((row) => row.id === evalEvent.id);
		assert.equal(evalRow?.kind, "event");
		assert.equal(evalRow?.title, "Eval passed");
		assert.equal(evalRow?.eventType, "eval.completed");
		assert.equal(evalRow?.summary, "smoke / 1 assertions");
		assert.deepEqual(
			evalRow?.details?.map((row) => row.label),
			["Trace", "Sequence", "Turn", "Eval", "Assertions", "Data"],
		);

		const newThread = await store.threads.getOrCreate({
			agent: "default",
			provider: "slack",
			team: "T1",
			channel: "slack:T1:C3",
			actor: "U3",
			key: "C3",
		});
		await store.messages.create({
			threadId: newThread.id,
			provider: "slack",
			kind: "slack",
			role: "user",
			actor: "U3",
			text: "new admin chat",
			createdAt: now + 1000,
		});
		const updatedLive = await service.live();
		assert.equal(updatedLive.threadRevisions[ownThread.id], ownThreadRevision);
		assert.notEqual(updatedLive.chatsRevision, live.chatsRevision);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("admin service sends local messages through the shared handler", async () => {
	const root = await mkdtemp(join(tmpdir(), "heypi-admin-send-"));
	try {
		const store = sqliteStore({ path: join(root, "heypi.db") });
		await store.setup();
		const service = createAdminService({
			store,
			handler: async (input) => {
				const thread = await store.threads.getOrCreate({
					agent: "default",
					provider: input.provider,
					kind: input.kind,
					team: input.team,
					channel: input.channel,
					actor: input.actor,
					key: input.thread,
				});
				await store.messages.create({
					threadId: thread.id,
					provider: input.provider,
					kind: input.kind,
					providerEventId: input.eventId,
					role: "user",
					actor: input.actor,
					text: input.text,
				});
				await store.messages.create({
					threadId: thread.id,
					provider: input.provider,
					kind: input.kind,
					role: "assistant",
					actor: "heypi",
					text: "local reply",
				});
				return { text: "local reply" };
			},
			logger: consoleLogger({ level: "error", format: "pretty" }),
			app: {
				agent: "default",
				runtime: { name: "host-bash", root: join(root, "workspace") },
				state: { root: stateRoot(root) },
				memory: { enabled: false, scope: "agent", writePolicy: "off", maxChars: 4000 },
				adapters: [],
				startedAt: Date.now(),
			},
		} as AdapterStart);

		const created = await service.sendMessage({ text: "hello from admin" });
		const thread = await service.thread(created.threadId);
		assert.equal(thread?.thread.provider, "local");
		assert.equal(
			thread?.timeline.some((row) => row.kind === "message" && row.title === "hello from admin"),
			true,
		);
		assert.equal(
			thread?.timeline.some((row) => row.kind === "message" && row.title === "local reply"),
			true,
		);

		const continued = await service.sendMessage({ threadId: created.threadId, text: "follow up", actor: "operator" });
		assert.equal(continued.threadId, created.threadId);
		const after = await service.thread(created.threadId);
		const followUp = after?.timeline.find((row) => row.kind === "message" && row.title === "follow up");
		assert.equal(followUp?.actor, "operator");
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("admin service resolves approvals through the shared handler", async () => {
	const root = await mkdtemp(join(tmpdir(), "heypi-admin-approval-"));
	try {
		const store = sqliteStore({ path: join(root, "heypi.db") });
		await store.setup();
		const handlerInputs: Array<Parameters<AdapterStart["handler"]>[0]> = [];
		const service = createAdminService({
			store,
			handler: async (input) => {
				handlerInputs.push(input);
				return { text: "approved" };
			},
			logger: consoleLogger({ level: "error", format: "pretty" }),
			app: {
				agent: "default",
				runtime: { name: "host-bash", root: join(root, "workspace") },
				state: { root: stateRoot(root) },
				memory: { enabled: false, scope: "agent", writePolicy: "off", maxChars: 4000 },
				adapters: [],
				startedAt: Date.now(),
			},
		} as AdapterStart);
		const thread = await store.threads.getOrCreate({
			agent: "default",
			provider: "slack",
			kind: "slack",
			team: "T1",
			channel: "C1",
			actor: "U_REQUESTER",
			key: "thread-key",
		});
		const approval = await store.approvals.create({
			agent: "default",
			callId: "call-1",
			channel: "slack:T1:C1",
			threadId: thread.id,
			turnId: "turn-1",
			command: "deploy prod",
			runtime: "host-bash",
			reason: "Production deploy",
			requestedBy: "U_REQUESTER",
		});

		const result = await service.resolveApproval({ id: approval.id, action: "approve", actor: "U_APPROVER" });

		assert.equal(result.threadId, thread.id);
		assert.equal(handlerInputs.length, 1);
		assert.deepEqual(
			{
				provider: handlerInputs[0]?.provider,
				kind: handlerInputs[0]?.kind,
				team: handlerInputs[0]?.team,
				channel: handlerInputs[0]?.channel,
				thread: handlerInputs[0]?.thread,
				actor: handlerInputs[0]?.actor,
				text: handlerInputs[0]?.text,
			},
			{
				provider: "slack",
				kind: "slack",
				team: "T1",
				channel: "C1",
				thread: "thread-key",
				actor: "U_APPROVER",
				text: `/approve ${approval.id}`,
			},
		);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("admin service sends thread control commands through the shared handler", async () => {
	const root = await mkdtemp(join(tmpdir(), "heypi-admin-thread-action-"));
	try {
		const store = sqliteStore({ path: join(root, "heypi.db") });
		await store.setup();
		const handlerInputs: Array<Parameters<AdapterStart["handler"]>[0]> = [];
		const service = createAdminService({
			store,
			handler: async (input) => {
				handlerInputs.push(input);
				return { text: "cancelled" };
			},
			logger: consoleLogger({ level: "error", format: "pretty" }),
			app: {
				agent: "default",
				runtime: { name: "host-bash", root: join(root, "workspace") },
				state: { root: stateRoot(root) },
				memory: { enabled: false, scope: "agent", writePolicy: "off", maxChars: 4000 },
				adapters: [],
				startedAt: Date.now(),
			},
		} as AdapterStart);
		const thread = await store.threads.getOrCreate({
			agent: "default",
			provider: "discord",
			kind: "guild",
			team: "G1",
			channel: "C1",
			actor: "U_REQUESTER",
			key: "thread-key",
		});

		const result = await service.sendThreadCommand({ threadId: thread.id, text: "/cancel run-1", actor: "U_ADMIN" });

		assert.equal(result.threadId, thread.id);
		assert.equal(handlerInputs.length, 1);
		assert.deepEqual(
			{
				provider: handlerInputs[0]?.provider,
				kind: handlerInputs[0]?.kind,
				team: handlerInputs[0]?.team,
				channel: handlerInputs[0]?.channel,
				thread: handlerInputs[0]?.thread,
				actor: handlerInputs[0]?.actor,
				text: handlerInputs[0]?.text,
			},
			{
				provider: "discord",
				kind: "guild",
				team: "G1",
				channel: "C1",
				thread: "thread-key",
				actor: "U_ADMIN",
				text: "/cancel run-1",
			},
		);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("admin configuration summarizes essentials with adapter icons", () => {
	const now = Date.now();
	const body = configurationView(
		{
			agent: { id: "agent", model: "openai/gpt-5-mini" },
			runtime: { name: "host-bash", root: "/tmp/workspace" },
			task: { busy: "followUp", cancel: "approver" },
			approval: {
				expiresInMs: 120_000,
				allowSelfApproval: false,
				bypass: { scope: "channel", durationMs: 60_000 },
			},
			activeBypasses: [
				{
					id: "bypass-1",
					agent: "agent",
					scope: "thread",
					channel: "slack:T1:C1",
					threadId: "thread-1",
					actor: "U_REQUESTER",
					createdBy: "U_ADMIN",
					reason: "Deploy",
					approvalId: "approval-1",
					createdAt: now - 30_000,
					expiresAt: now + 60_000,
					revokedAt: null,
					revokedBy: null,
				},
			],
			startedAt: now - 120_000,
			adapters: [
				{ name: "ops", kind: "slack", permissions: { approvers: ["U_APPROVER"], admins: { groups: ["S_ADMIN"] } } },
				{ name: "github", kind: "webhook" },
			],
			memory: {
				enabled: true,
				scope: "agent",
				writePolicy: "approvers",
				maxChars: 20_000,
				total: 1,
				limit: 25,
				offset: 0,
				hasNext: false,
				entries: [
					{
						scopePath: "agent/MEMORY.md",
						path: "/tmp/workspace/memory/agent/MEMORY.md",
						size: 12,
						mtimeMs: now,
						sha256: "abc123def456",
						text: "Remember this.",
						truncated: false,
					},
				],
			},
			threads: 3,
			live: {
				pendingApprovals: 1,
				runningRuns: 2,
				jobs: 3,
				activeJobs: 2,
				pausedJobs: 1,
				recentCalls: 4,
				checkedAt: now,
				revision: "rev",
				chatsRevision: "chats-rev",
				threadRevisions: {},
			},
		},
		{ host: "127.0.0.1", port: 3000 },
	);
	assert.match(body, /Configuration and process details/);
	assert.match(body, /text-sm md:grid-cols-2/);
	assert.match(body, /truncate/);
	assert.match(body, /Agent/);
	assert.match(body, /Model/);
	assert.match(body, /Runtime/);
	assert.match(body, /HTTP/);
	assert.match(body, /Task/);
	assert.match(body, /Busy: followUp; cancel: approver/);
	assert.match(body, /Approval/);
	assert.match(body, /expires: 2m(?: 0s)?; self: blocked; bypass: channel for 1m(?: 0s)?/);
	assert.match(body, /Active bypasses/);
	assert.match(body, /bypass-1/);
	assert.match(body, /actor U_REQUESTER target slack:T1:C1 \/ thread-1 by U_ADMIN/);
	assert.match(body, /Adapters/);
	assert.match(body, /title="slack, 1 approver, 1 admin"/);
	assert.match(body, /ops/);
	assert.match(body, /1 approver/);
	assert.match(body, /1 admin/);
	assert.match(body, /github/);
	assert.doesNotMatch(body, /ops \(slack\)/);
	assert.match(body, /Memory/);
	assert.match(body, /Enabled, shared by agent, approver writes/);
	assert.doesNotMatch(body, /1 files/);
	assert.match(body, /Started/);
	assert.match(body, /Last updated/);
	assert.doesNotMatch(body, /Threads/);
	assert.doesNotMatch(body, /Agent folder/);
});

test("admin approvals expiry uses duration labels", () => {
	const now = Date.now();
	const body = approvalsView(
		{
			limit: 25,
			offset: 0,
			hasNext: false,
			rows: [
				{
					id: "approval-1",
					agent: "default",
					callId: "call-1",
					channel: "slack::C123",
					threadId: null,
					turnId: null,
					requestMessageId: null,
					command: "systemctl restart api",
					runtime: "host-bash",
					reason: "Run command",
					details: null,
					state: "pending",
					requestedBy: "U123",
					requestedAt: now - 30_000,
					expiresAt: now + (3 * 24 * 60 + 60) * 60 * 1000,
					resolvedAt: null,
					resolvedBy: null,
				},
			],
		},
		undefined,
		{ csrf: "csrf-1" },
	);
	assert.match(body, />3d(?: \d+h)?</);
	assert.doesNotMatch(body, />in 3d</);
	assert.doesNotMatch(body, />3d ago</);
	assert.match(body, /action="\/admin\/approvals"/);
	assert.match(body, /name="id" value="approval-1"/);
	assert.match(body, /name="actor" value="admin"/);
	assert.match(body, /name="action" value="approve"/);
	assert.match(body, /name="action" value="deny"/);
});

test("admin memory empty state explains saved memory files", () => {
	const body = memoryView({
		enabled: true,
		scope: "agent",
		writePolicy: "approvers",
		maxChars: 4000,
		total: 0,
		limit: 25,
		offset: 0,
		hasNext: false,
		entries: [],
	});
	assert.match(body, /No memory files/);
	assert.match(body, /Once the agent starts saving memory/);
	assert.match(body, /data-admin-empty-state/);
	assert.match(body, /data-admin-empty-title>No memory files<\/h3>/);
});

test("admin memory page explains disabled memory", () => {
	const body = memoryView({
		enabled: false,
		scope: "agent",
		writePolicy: "off",
		maxChars: 4000,
		total: 0,
		limit: 25,
		offset: 0,
		hasNext: false,
		entries: [],
	});
	assert.match(body, /Memory disabled/);
	assert.match(body, /running without durable memory/);
	assert.match(body, /Enable memory in the app config/);
	assert.doesNotMatch(body, /No memory files/);
});

test("admin memory table uses details dialog for file content", () => {
	const now = Date.now();
	const body = memoryView({
		enabled: true,
		scope: "user",
		writePolicy: "approvers",
		maxChars: 4000,
		total: 2,
		limit: 1,
		offset: 0,
		hasNext: true,
		entries: [
			{
				scopePath: "user/U123",
				path: "/tmp/workspace/memory/scopes/user/U123/MEMORY.md",
				size: 64,
				mtimeMs: now,
				sha256: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
				text: "- <script>alert(1)</script>\n",
				truncated: false,
			},
		],
	});
	assert.match(body, /data-admin-column="Scope"/);
	assert.match(body, /data-admin-column="Content"/);
	assert.match(body, /data-admin-column="Size"/);
	assert.match(body, /data-admin-column="Updated"/);
	assert.match(body, /data-admin-column="Hash"/);
	assert.match(body, /user\/U123/);
	assert.match(body, /0123456789ab/);
	assert.match(body, /data-admin-dialog-open="memory-detail-0"/);
	assert.match(body, /Memory details/);
	assert.match(body, /aria-label="Copy scope"/);
	assert.match(body, /data-admin-copy-label="scope"/);
	assert.match(body, /aria-label="Copy path"/);
	assert.match(body, /aria-label="Copy SHA-256"/);
	assert.match(body, /aria-label="Copy content"/);
	assert.match(body, /data-admin-copy="\/tmp\/workspace\/memory\/scopes\/user\/U123\/MEMORY\.md"/);
	assert.match(body, />\/tmp\/workspace\/memory\/scopes\/user\/U123\/MEMORY\.md<\/span>/);
	assert.match(body, />Content<\/div>/);
	assert.match(body, /data-admin-memory-content/);
	assert.match(body, /<rect width="14" height="14" x="8" y="8" rx="2" ry="2"\/>/);
	assert.doesNotMatch(body, /<pre/);
	assert.match(body, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
	assert.doesNotMatch(body, /<script>alert\(1\)<\/script>/);
	assert.match(body, /aria-label="pagination"/);
});

test("admin chats threads and thread detail render URL-backed timeline", () => {
	const now = Date.now();
	const threadRow = {
		id: "thread-1",
		provider: "slack",
		kind: "slack",
		channel: "C123",
		actor: "U123",
		state: "running",
		title: "C123 · U123",
		summary: "Message: deploy api",
		createdAt: now - 5000,
		updatedAt: now - 5000,
		lastActivityAt: now - 1000,
		pendingApprovals: 0,
		runningRuns: 1,
		latestEvent: "message:message-1",
	};
	const discordThreadRow = {
		...threadRow,
		id: "thread-2",
		provider: "discord",
		kind: "discord",
		channel: "D123",
		actor: "U456",
		title: "D123 · U456",
		summary: "Message: check logs",
		latestEvent: "message:message-2",
	};
	const threadsBody = threadsView(
		{
			limit: 25,
			offset: 25,
			hasNext: true,
			rows: [threadRow, discordThreadRow],
			filters: { q: "deploy", provider: "discord" },
			facets: { providers: ["discord", "slack"], channels: [], actors: [], scopes: [] },
		},
		{
			checkedAt: now,
			live: {
				pendingApprovals: 2,
				runningRuns: 1,
				jobs: 3,
				activeJobs: 2,
				pausedJobs: 1,
				recentCalls: 4,
				checkedAt: now,
				revision: "live-1",
				chatsRevision: "chats-1",
				threadRevisions: {},
			},
		},
	);
	assert.doesNotMatch(threadsBody, />Chats<\/h2>/);
	assert.doesNotMatch(threadsBody, /Recent conversations across connected channels\./);
	assert.doesNotMatch(threadsBody, /data-admin-chat-pulse/);
	assert.doesNotMatch(threadsBody, /data-admin-chat-pulse-link/);
	assert.doesNotMatch(threadsBody, /role="tab"/);
	assert.match(threadsBody, /data-admin-chats/);
	assert.doesNotMatch(threadsBody, /data-admin-chats-card/);
	assert.doesNotMatch(threadsBody, /data-admin-chats-header/);
	assert.doesNotMatch(threadsBody, /data-admin-chats-sidebar/);
	assert.doesNotMatch(threadsBody, /data-admin-chat-search/);
	assert.doesNotMatch(threadsBody, /data-admin-chat-provider-filter/);
	assert.doesNotMatch(threadsBody, /href="\/admin\?limit=25&amp;offset=50&amp;q=deploy&amp;provider=discord"/);
	assert.doesNotMatch(threadsBody, /pl-8/);
	assert.doesNotMatch(threadsBody, /absolute left-2\.5/);
	assert.doesNotMatch(threadsBody, /All states/);
	assert.doesNotMatch(threadsBody, /All channels/);
	assert.doesNotMatch(threadsBody, /All actors/);
	assert.doesNotMatch(threadsBody, />Filter<\/button>/);
	assert.doesNotMatch(threadsBody, /data-admin-chats-layout/);
	assert.match(threadsBody, /data-admin-compose/);
	assert.match(threadsBody, /action="\/admin\/messages"/);
	assert.match(threadsBody, /aria-label="Send message"/);
	assert.doesNotMatch(threadsBody, /data-admin-thread-groups/);
	assert.doesNotMatch(threadsBody, /data-admin-thread-item/);
	assert.doesNotMatch(threadsBody, />Running<\/span>/);
	assert.match(threadsBody, /Select a thread/);

	const shell = page({
		title: "Chats",
		active: "chats",
		csrf: "csrf-1",
		auth: false,
		live: {
			pendingApprovals: 2,
			runningRuns: 1,
			jobs: 3,
			activeJobs: 2,
			pausedJobs: 1,
			recentCalls: 4,
			checkedAt: now,
			revision: "live-1",
			chatsRevision: "chats-1",
			threadRevisions: {},
		},
		memoryFiles: 5,
		threads: {
			limit: 25,
			offset: 0,
			hasNext: false,
			rows: [threadRow, discordThreadRow],
		},
		body: threadsBody,
		nonce: "nonce-1",
		livePage: true,
	});
	assert.match(shell, /id="admin-sidebar" class="sidebar"/);
	assert.match(shell, /data-admin-sidebar-content/);
	assert.match(shell, /<button type="button" data-admin-command-open>/);
	assert.match(shell, /Approvals[\s\S]*data-live-field="pendingApprovals">2<\/span>/);
	assert.match(shell, /Jobs[\s\S]*data-live-field="jobs">3<\/span>/);
	assert.match(shell, /Slack[\s\S]*href="\/admin\/threads\/thread-1\?event=message%3Amessage-1"/);
	assert.match(shell, /discord · Discord[\s\S]*href="\/admin\/threads\/thread-2\?event=message%3Amessage-2"/);
	assert.match(shell, /aria-disabled="true"[\s\S]*Log out/);
	assert.match(shell, /id="admin-command"/);
	assert.match(shell, /href="\/admin\/memory"[^>]+role="menuitem"/);

	const event = {
		id: "message-1",
		kind: "message" as const,
		threadId: "thread-1",
		title: "deploy api",
		summary: "user / slack / slack",
		state: "done",
		provider: "slack",
		eventType: "slack",
		role: "user",
		channel: "C123",
		actor: "U123",
		time: now - 1000,
		details: [
			{ label: "Thread", value: "thread-1", format: "mono" as const },
			{ label: "Text", value: "**deploy** `api`\n- first check", format: "text" as const },
		],
	};
	const runEvent = {
		id: "run-1",
		kind: "run" as const,
		threadId: "thread-1",
		title: "deploy api",
		summary: "Deployment queued",
		state: "running",
		provider: "slack",
		eventType: "slack",
		channel: "C123",
		actor: "U123",
		time: now - 900,
	};
	const callEvent = {
		id: "call-1",
		kind: "call" as const,
		threadId: "thread-1",
		title: "host_exec",
		summary: "npm test",
		state: "done",
		channel: "C123",
		actor: "U123",
		time: now - 800,
		durationMs: 1200,
		details: [
			{ label: "Thread", value: "thread-1", format: "mono" as const },
			{ label: "Runtime", value: "host-bash" },
			{ label: "Stdout", value: "tests passed", format: "text" as const },
		],
	};
	const traceEvent = {
		id: "event-1",
		kind: "event" as const,
		threadId: "thread-1",
		title: "tool.completed",
		summary: '{"tool":"host_exec","state":"done"}',
		state: "done",
		trace: "trace-1",
		time: now - 750,
		seq: 4,
		details: [
			{ label: "Trace", value: "trace-1", format: "mono" as const },
			{ label: "Sequence", value: "4", format: "mono" as const },
			{ label: "Call", value: "call-1", format: "mono" as const },
			{ label: "Data", value: '{"tool":"host_exec","state":"done"}', format: "text" as const },
		],
	};
	const assistantEvent = {
		id: "message-2",
		kind: "message" as const,
		threadId: "thread-1",
		title: "Deployment is ready",
		summary: "assistant / slack / slack",
		state: "done",
		provider: "slack",
		eventType: "slack",
		role: "assistant",
		channel: "C123",
		actor: "heypi",
		time: now - 700,
		details: [
			{ label: "Thread", value: "thread-1", format: "mono" as const },
			{ label: "Text", value: "Deployment is ready", format: "text" as const },
		],
	};
	const emptyEvent = {
		id: "message-empty",
		kind: "message" as const,
		threadId: "thread-1",
		title: "Empty message",
		summary: "assistant / slack / slack",
		state: "done",
		provider: "slack",
		eventType: "slack",
		role: "assistant",
		channel: "C123",
		actor: "heypi",
		time: now - 600,
		details: [{ label: "Thread", value: "thread-1", format: "mono" as const }],
	};
	const threadBody = threadsView(
		{
			limit: 25,
			offset: 0,
			hasNext: false,
			rows: [threadRow],
		},
		{
			checkedAt: now,
			selected: {
				thread: threadRow,
				timeline: [runEvent, callEvent, traceEvent, event, assistantEvent, emptyEvent],
				selected: callEvent,
				event: "call:call-1",
			},
			csrf: "csrf-1",
		},
	);
	assert.doesNotMatch(threadBody, /data-tooltip="slack"/);
	assert.doesNotMatch(threadBody, /data-admin-thread-sticky-header/);
	assert.doesNotMatch(threadBody, /data-admin-thread-header/);
	assert.doesNotMatch(threadBody, /Channel C123 · Created /);
	assert.doesNotMatch(threadBody, / · Last updated /);
	assert.doesNotMatch(threadBody, /href="\/admin\/threads\/thread-1\?event=message%3Amessage-1"/);
	assert.doesNotMatch(threadBody, /aria-current="true"/);
	assert.match(threadBody, /data-selected-event="true"/);
	assert.match(threadBody, /data-admin-thread-scroll/);
	assert.doesNotMatch(threadBody, /data-admin-thread-list/);
	assert.match(threadBody, /name="threadId" value="thread-1"/);
	assert.match(threadBody, /data-admin-compose-text/);
	assert.match(threadBody, /<article id="event-message-message-1" data-admin-message-role="user"/);
	assert.match(threadBody, />U123 <span aria-hidden="true">·<\/span>/);
	assert.match(threadBody, /data-align="end"/);
	assert.match(threadBody, /Deployment is ready/);
	assert.match(threadBody, /<article id="event-message-message-2" data-admin-message-role="assistant"/);
	assert.match(threadBody, />Empty message<\/p>/);
	assert.doesNotMatch(threadBody, /\(empty message\)/);
	assert.doesNotMatch(threadBody, /heypi <span aria-hidden="true">·<\/span>/);
	assert.match(threadBody, /<strong>deploy<\/strong> api/);
	assert.doesNotMatch(threadBody, /<code/);

	const threadShell = page({
		title: "Thread",
		active: "chats",
		csrf: "csrf-1",
		live: {
			pendingApprovals: 0,
			runningRuns: 1,
			jobs: 0,
			activeJobs: 0,
			pausedJobs: 0,
			recentCalls: 1,
			checkedAt: now,
			revision: "live-2",
			chatsRevision: "chats-2",
			threadRevisions: { "thread-1": "thread-revision-1" },
		},
		memoryFiles: 0,
		threads: {
			limit: 25,
			offset: 0,
			hasNext: false,
			rows: [threadRow],
		},
		body: threadBody,
		nonce: "nonce-1",
		livePage: true,
		liveThreadId: "thread-1",
	});
	assert.match(threadShell, /data-admin-main-header[\s\S]*data-tooltip="slack"/);
	assert.match(threadShell, /data-admin-main-header[\s\S]*data-admin-thread-channel>C123<\/h2>/);
	assert.match(threadShell, /data-admin-main-header[\s\S]*data-admin-thread-id>thread-1<\/span>/);
	assert.doesNotMatch(threadShell, /data-admin-page-title>Thread<\/h1>/);
	assert.doesNotMatch(threadShell, /data-admin-main-header[\s\S]*New message[\s\S]*<\/header>/);
	assert.doesNotMatch(threadShell, /data-admin-main-header[\s\S]*data-admin-docs-link[\s\S]*<\/header>/);
	assert.match(threadBody, /<ul[^>]*><li>first check<\/li><\/ul>/);
	assert.match(
		threadBody,
		/<details id="event-call-call-1"[^>]+data-admin-context-row="call"[^>]+data-selected-event="true"/,
	);
	assert.match(threadBody, /data-admin-context-summary/);
	assert.match(threadBody, /data-admin-context-details/);
	assert.match(threadBody, /action="\/admin\/thread-actions"/);
	assert.match(threadBody, /data-admin-thread-action="cancel"/);
	assert.match(threadBody, /name="action" value="cancel"/);
	assert.match(threadBody, /name="id" value="run-1"/);
	assert.match(threadBody, /aria-label="Cancel run"/);
	assert.match(threadBody, /data-admin-thread-action="status"/);
	assert.match(threadBody, /name="action" value="status"/);
	assert.match(threadBody, /name="id" value="call-1"/);
	assert.match(threadBody, /aria-label="Show call status"/);
	assert.match(threadBody, /name="actor" value="admin"/);
	assert.match(threadBody, />Runtime<\/span>/);
	assert.match(threadBody, /data-admin-context-row="event"/);
	assert.match(threadBody, />Trace<\/span>/);
	assert.match(threadBody, />Sequence<\/span>/);
	assert.match(threadBody, />Data<\/span>/);
	assert.match(threadBody, /tool\.completed/);
	assert.doesNotMatch(threadBody, />Stdout<\/span>/);
	assert.doesNotMatch(threadBody, />ID<\/div>/);
	assert.match(threadBody, /host_exec/);
	assert.doesNotMatch(threadBody, /tests passed/);
	assert.match(threadBody, /npm test/);
	assert.match(threadBody, /deploy api/);
	assert.match(threadBody, /Deployment queued/);
	assert.doesNotMatch(threadBody, /user \/ slack \/ slack/);
	assert.doesNotMatch(threadBody, /C123 · U123<\/h2>/);
	assert.doesNotMatch(threadBody, /Activity details/);
});

test("admin one-time login issues a session and logout requires CSRF", async () => {
	const root = await mkdtemp(join(tmpdir(), "heypi-admin-auth-"));
	const port = await freePort();
	const logs: LogEntry[] = [];
	const app = createHeypi({
		store: sqliteStore({ path: join(root, "heypi.db") }),
		state: { root: stateRoot(root) },
		logger: captureLogger(logs),
		http: { port },
		admin: { http: { port } },
		adapters: [],
		agent: loadAgent("../../examples/slack-devops/agent", { id: "default", model: "openai/gpt-5-mini" }),
		runtime: { name: "host-bash", root: workspace(join(root, "workspace")) },
	});
	try {
		await app.start();
		const loginPage = await fetch(`http://127.0.0.1:${port}/admin/login`);
		assert.equal(loginPage.status, 200);
		const loginBody = await loginPage.text();
		assert.match(loginBody, /Admin access only/);
		assert.match(loginBody, /More about heypi/);
		assert.match(loginBody, /https:\/\/heypi\.dev\/docs/);
		assert.match(loginBody, /target="_blank"/);
		assert.match(loginBody, /data-admin-empty-state/);

		for (const path of ["/admin", "/admin/configuration", "/admin/events", "/admin/_pulse"]) {
			const protectedRoute = await fetch(`http://127.0.0.1:${port}${path}`, { redirect: "manual" });
			assert.equal(protectedRoute.status, 303);
			assert.equal(protectedRoute.headers.get("location"), "/admin/login");
		}

		const url = loginUrl(logs);
		const login = await fetch(url, { redirect: "manual" });
		assert.equal(login.status, 303);
		assert.equal(login.headers.get("location"), "/admin");
		const cookie = cookieHeader(login);

		const reused = await fetch(url, { redirect: "manual" });
		assert.equal(reused.status, 401);
		const reusedBody = await reused.text();
		assert.match(reusedBody, /Admin access failed/);
		assert.match(reusedBody, /Invalid or expired login link/);
		assert.match(reusedBody, /data-admin-empty-state/);
		assert.doesNotMatch(reusedBody, /data-admin-theme-toggle/);

		const adminPage = await fetch(`http://127.0.0.1:${port}/admin`, { headers: { cookie } });
		assert.equal(adminPage.status, 200);
		assert.match(adminPage.headers.get("content-security-policy") ?? "", /style-src 'self' 'nonce-[^']+'/);
		const body = await adminPage.text();
		assert.match(body, /heypi admin/);
		assert.match(body, /aria-label="heypi"/);
		assert.match(body, /data-admin-docs-link/);
		assert.match(body, /data-admin-logout/);
		assert.match(body, /id="admin-sidebar" class="sidebar"/);
		assert.match(body, /data-admin-sidebar-content/);
		assert.match(body, /data-admin-command-open/);
		assert.match(body, /id="admin-command"/);
		assert.match(body, /data-admin-sidebar-link="approvals"/);
		assert.match(body, /data-admin-sidebar-link="jobs"/);
		assert.match(body, /data-admin-sidebar-link="memory"/);
		assert.match(body, /data-admin-sidebar-link="configuration"/);
		assert.match(body, /Approvals<\/span><span[^>]+data-live-field="pendingApprovals">0<\/span>/);
		assert.match(body, /Jobs<\/span><span[^>]+data-live-field="jobs">0<\/span>/);
		assert.match(body, /Memory<\/span><span[^>]*>0<\/span>/);
		assert.match(body, /href="https:\/\/heypi\.dev\/docs"[^>]+data-admin-docs-link/);
		assert.match(body, /button type="submit"[^>]+data-admin-logout/);
		assert.match(body, /Toggle theme/);
		assert.match(body, /data-admin-theme-icon="moon"/);
		assert.match(body, /data-admin-theme-icon="sun"/);
		assert.match(body, /href="https:\/\/heypi\.dev\/docs"/);
		assert.match(body, /aria-label="Docs"/);
		assert.match(body, /data-tooltip="Docs"/);
		assert.match(body, /aria-label="Toggle theme"/);
		assert.match(body, /data-tooltip="Toggle theme"/);
		assert.doesNotMatch(body, /aria-current="false"/);
		assert.doesNotMatch(body, /data-tooltip="Toggle dark mode"/);
		assert.doesNotMatch(body, /title="Toggle dark mode"/);
		assert.doesNotMatch(body, /data-admin-nav-mobile/);
		assert.doesNotMatch(body, /data-admin-nav-desktop/);
		assert.doesNotMatch(body, /id="admin-mobile-menu"/);
		assert.match(body, /data-admin-main/);
		assert.match(body, /data-admin-page-title>Chats<\/h1>/);
		assert.match(body, /data-admin-thread-panel/);
		assert.doesNotMatch(body, /Recent conversations across connected channels\./);
		assert.doesNotMatch(body, /data-admin-chats-card/);
		assert.doesNotMatch(body, /data-admin-chat-search/);
		assert.doesNotMatch(body, /role="tablist"/);
		assert.doesNotMatch(body, /href="\/admin\/activity"/);
		assert.match(body, /Select a thread/);
		assert.doesNotMatch(body, /Chats<span/);
		assert.doesNotMatch(body, /data-admin-sidebar-link="chats"/);
		assert.doesNotMatch(body, /data-admin-sidebar-link="evals"/);
		assert.match(body, /href="\/admin\/configuration"[^>]*data-admin-sidebar-link="configuration"[^>]*>/);
		assert.doesNotMatch(body, /ml-auto min-w-0/);
		assert.doesNotMatch(body, /Agent folder/);
		assert.doesNotMatch(body, /Uptime/);
		assert.doesNotMatch(body, /Admin auth/);
		assert.doesNotMatch(body, /Cookies/);
		assert.doesNotMatch(body, /Pending approvals/);
		assert.match(body, /\/admin\/approvals/);
		assert.match(body, /\/admin\/jobs/);
		assert.match(body, /\/admin\/memory/);
		assert.match(body, /\/admin\/configuration/);
		assert.doesNotMatch(body, /\/admin\/access/);
		assert.doesNotMatch(body, /\/admin\/routes/);
		assert.match(body, /prefers-color-scheme: dark/);
		assert.match(body, /localStorage\.getItem\(key\)/);
		assert.match(body, /addEventListener\?\.\("change"/);
		assert.match(body, /basecoat:theme/);
		assert.match(body, /data-admin-theme-toggle/);
		assert.match(body, /function threadScrollContainer\(\)/);
		assert.match(body, /heypi:admin:thread-scroll:/);
		assert.match(body, /data-live-revision="[a-f0-9]{16}"/);
		assert.match(body, /data-live-chats-revision="[a-f0-9]{16}"/);
		assert.match(body, /const liveThreadId = document\.body\.dataset\.liveThreadId \|\| "";/);
		assert.match(body, /data\.chatsRevision !== currentChatsRevision/);
		assert.match(body, /data\.threadRevisions\?\.\[liveThreadId\]/);
		assert.match(body, /sessionStorage\.setItem\(threadScrollKey\(\), threadAtBottom\(container\) \? "bottom"/);
		assert.match(body, /new MutationObserver/);
		assert.doesNotMatch(body, /scrollIntoView/);
		assert.match(body, /navigator\.clipboard/);
		assert.match(body, /button\.innerHTML = '<svg/);
		assert.match(body, /setTimeout\(\(\) => \{/);
		assert.match(body, /\}, 1500\)/);
		assert.match(body, /fallbackCopy/);
		assert.match(body, /execCommand\("copy"\)/);
		assert.match(body, /data-admin-copy/);
		assert.match(body, /basecoat\.all\.min\.js/);
		assert.match(body, /Last updated/);
		assert.doesNotMatch(body, /Live summary connecting/);
		assert.doesNotMatch(body, /Checked /);
		assert.doesNotMatch(body, /New admin data available/);
		const csrf = requiredMatch(body, /name="csrf" value="([^"]+)"/u);

		const css = await fetch(`http://127.0.0.1:${port}/admin/assets/admin.css`);
		assert.equal(css.status, 200);
		assert.match(css.headers.get("content-type") ?? "", /text\/css/);
		assert.match(await css.text(), /tailwindcss|\.btn/u);

		const js = await fetch(`http://127.0.0.1:${port}/admin/assets/basecoat.all.min.js`);
		assert.equal(js.status, 200);
		assert.match(js.headers.get("content-type") ?? "", /application\/javascript/);
		assert.match(await js.text(), /basecoat/);

		const events = await firstEvent(`http://127.0.0.1:${port}/admin/events`, cookie);
		assert.match(events, /event: summary/);

		const config = await fetch(`http://127.0.0.1:${port}/admin/configuration`, { headers: { cookie } });
		assert.equal(config.status, 200);
		const configBody = await config.text();
		assert.match(configBody, /data-admin-page-title>Configuration<\/h1>/);
		assert.match(configBody, /Agent/);
		assert.match(configBody, /Model/);
		assert.match(configBody, /Runtime/);
		assert.match(configBody, /HTTP/);
		assert.match(configBody, /Adapters/);
		assert.match(configBody, /Memory/);
		assert.match(configBody, /Started/);
		assert.match(configBody, /ago \(/);
		assert.doesNotMatch(configBody, /Uptime/);

		const summary = await fetch(`http://127.0.0.1:${port}/admin/summary`, {
			headers: { cookie },
			redirect: "manual",
		});
		assert.equal(summary.status, 303);
		assert.equal(summary.headers.get("location"), "/admin/configuration");

		const activity = await fetch(`http://127.0.0.1:${port}/admin/activity`, {
			headers: { cookie },
			redirect: "manual",
		});
		assert.equal(activity.status, 303);
		assert.equal(activity.headers.get("location"), "/admin");

		const jobs = await fetch(`http://127.0.0.1:${port}/admin/jobs`, { headers: { cookie } });
		assert.equal(jobs.status, 200);
		const jobsBody = await jobs.text();
		assert.match(jobsBody, /No jobs configured/);
		assert.match(jobsBody, /Once scheduled or heartbeat jobs are configured/);
		assert.match(jobsBody, /data-admin-empty-state/);

		const evals = await fetch(`http://127.0.0.1:${port}/admin/evals`, { headers: { cookie } });
		assert.equal(evals.status, 200);
		const evalsBody = await evals.text();
		assert.match(evalsBody, /No evals configured/);
		assert.match(evalsBody, /evals\//);

		const missing = await fetch(`http://127.0.0.1:${port}/admin/missing`, { headers: { cookie } });
		assert.equal(missing.status, 404);
		const missingBody = await missing.text();
		assert.match(missingBody, /Page not found/);
		assert.match(missingBody, /More about heypi/);
		assert.match(missingBody, /https:\/\/heypi\.dev\/docs/);
		assert.match(missingBody, /target="_blank"/);
		assert.match(missingBody, /data-admin-empty-state/);
		assert.doesNotMatch(missingBody, /data-admin-theme-toggle/);

		const blocked = await fetch(`http://127.0.0.1:${port}/admin/logout`, {
			method: "POST",
			headers: {
				cookie,
				"content-type": "application/x-www-form-urlencoded",
				origin: "http://evil.example",
			},
			body: new URLSearchParams({ csrf }),
			redirect: "manual",
		});
		assert.equal(blocked.status, 403);

		const logout = await fetch(`http://127.0.0.1:${port}/admin/logout`, {
			method: "POST",
			headers: {
				cookie,
				"content-type": "application/x-www-form-urlencoded",
				origin: `http://127.0.0.1:${port}`,
			},
			body: new URLSearchParams({ csrf }),
			redirect: "manual",
		});
		assert.equal(logout.status, 303);
		assert.equal(logout.headers.get("location"), "/admin/login");

		const after = await fetch(`http://127.0.0.1:${port}/admin`, { headers: { cookie }, redirect: "manual" });
		assert.equal(after.status, 303);
		assert.equal(after.headers.get("location"), "/admin/login");
	} finally {
		await app.stop();
		await rm(root, { recursive: true, force: true });
	}
});

test("admin auth can be disabled for loopback UI testing", async () => {
	const root = await mkdtemp(join(tmpdir(), "heypi-admin-no-auth-"));
	const port = await freePort();
	const logs: LogEntry[] = [];
	const app = createHeypi({
		store: sqliteStore({ path: join(root, "heypi.db") }),
		state: { root: stateRoot(root) },
		logger: captureLogger(logs),
		http: { port },
		admin: { auth: false, http: { port } },
		adapters: [],
		agent: loadAgent("../../examples/slack-devops/agent", { id: "default", model: "openai/gpt-5-mini" }),
		runtime: { name: "host-bash", root: workspace(join(root, "workspace")) },
	});
	try {
		await app.start();
		assert.deepEqual(loginUrls(logs), []);

		const adminPage = await fetch(`http://127.0.0.1:${port}/admin`, { redirect: "manual" });
		assert.equal(adminPage.status, 200);
		const body = await adminPage.text();
		assert.match(body, /heypi admin/);
		assert.match(body, /aria-disabled="true"[\s\S]*Log out/);
		assert.doesNotMatch(body, /data-admin-logout/);
		const csrf = requiredMatch(body, /name="csrf" value="([^"]+)"/u);
		assert.ok(csrf);

		const blocked = await fetch(`http://127.0.0.1:${port}/admin/messages`, {
			method: "POST",
			headers: {
				"content-type": "application/x-www-form-urlencoded",
				origin: "http://evil.example",
			},
			body: new URLSearchParams({ csrf }),
			redirect: "manual",
		});
		assert.equal(blocked.status, 403);

		const missingText = await fetch(`http://127.0.0.1:${port}/admin/messages`, {
			method: "POST",
			headers: {
				"content-type": "application/x-www-form-urlencoded",
				origin: `http://127.0.0.1:${port}`,
			},
			body: new URLSearchParams({ csrf }),
			redirect: "manual",
		});
		assert.equal(missingText.status, 400);

		const loginPage = await fetch(`http://127.0.0.1:${port}/admin/login`, { redirect: "manual" });
		assert.equal(loginPage.status, 303);
		assert.equal(loginPage.headers.get("location"), "/admin");

		const events = await firstEvent(`http://127.0.0.1:${port}/admin/events`);
		assert.match(events, /event: summary/);
	} finally {
		await app.stop();
		await rm(root, { recursive: true, force: true });
	}
});

test("admin thread routes render timelines and reject bad thread paths", async () => {
	const root = await mkdtemp(join(tmpdir(), "heypi-admin-thread-route-"));
	const port = await freePort();
	const store = sqliteStore({ path: join(root, "heypi.db") });
	const app = createHeypi({
		store,
		state: { root: stateRoot(root) },
		logger: captureLogger([]),
		http: { port },
		admin: { auth: false, http: { port } },
		adapters: [],
		agent: loadAgent("../../examples/slack-devops/agent", { id: "default", model: "openai/gpt-5-mini" }),
		runtime: { name: "host-bash", root: workspace(join(root, "workspace")) },
	});
	try {
		await app.start();
		const thread = await store.threads.getOrCreate({
			agent: "default",
			provider: "slack",
			team: "T1",
			channel: "C123",
			actor: "U123",
			key: "C123",
		});
		const message = await store.messages.create({
			threadId: thread.id,
			provider: "slack",
			kind: "slack",
			role: "user",
			actor: "U123",
			text: "debug the deployment",
		});

		const threadPage = await fetch(
			`http://127.0.0.1:${port}/admin/threads/${encodeURIComponent(thread.id)}?event=${encodeURIComponent(`message:${message.id}`)}`,
		);
		assert.equal(threadPage.status, 200);
		const threadBody = await threadPage.text();
		assert.match(threadBody, new RegExp(`data-live-thread-id="${thread.id}"`, "u"));
		assert.match(threadBody, /data-live-thread-revision="[a-f0-9]{16}"/);
		assert.match(threadBody, /debug the deployment/);
		assert.match(threadBody, /data-selected-event="true"/);

		const panel = await fetch(
			`http://127.0.0.1:${port}/admin/threads/${encodeURIComponent(thread.id)}/_panel?event=${encodeURIComponent(`message:${message.id}`)}`,
		);
		assert.equal(panel.status, 200);
		const panelBody = await panel.text();
		assert.match(panelBody, /data-admin-thread-scroll/);
		assert.match(panelBody, /debug the deployment/);
		assert.match(panelBody, /data-selected-event="true"/);
		assert.doesNotMatch(panelBody, /<!doctype html>/);
		assert.doesNotMatch(panelBody, /data-admin-main/);

		const missing = await fetch(`http://127.0.0.1:${port}/admin/threads/missing`);
		assert.equal(missing.status, 404);
		assert.match(await missing.text(), /Thread not found|Page not found/);

		const malformed = await fetch(`http://127.0.0.1:${port}/admin/threads/%E0%A4%A`);
		assert.equal(malformed.status, 404);
		assert.match(await malformed.text(), /Page not found/);
	} finally {
		await app.stop();
		await rm(root, { recursive: true, force: true });
	}
});

test("admin state signs fresh one-time login links", async () => {
	const root = await mkdtemp(join(tmpdir(), "heypi-admin-link-"));
	const logs: LogEntry[] = [];
	const app = createHeypi({
		store: sqliteStore({ path: join(root, "heypi.db") }),
		state: { root: stateRoot(root) },
		logger: captureLogger(logs),
		http: { port: 0 },
		admin: { http: { port: 0 } },
		adapters: [],
		agent: loadAgent("../../examples/slack-devops/agent", { id: "default", model: "openai/gpt-5-mini" }),
		runtime: { name: "host-bash", root: workspace(join(root, "workspace")) },
	});
	try {
		await app.start();
		const servers = readAdminServerDescriptors(stateRoot(root));
		assert.equal(servers.length, 1);
		const server = servers[0].descriptor;
		assert.ok(server.instanceId);
		assert.doesNotMatch(server.url, /:0(?:\/|$)/);
		const loginPage = await fetch(`${server.url}/admin/login`, { redirect: "manual" });
		assert.equal(loginPage.headers.get("x-heypi-admin-instance"), server.instanceId);
		if (process.platform !== "win32") {
			const adminState = await stat(join(stateRoot(root), "admin"));
			assert.equal(adminState.mode & 0o077, 0);
		}
		const signed = createAdminLoginToken(readAdminSecret(stateRoot(root)), 300_000, { stateRoot: stateRoot(root) });
		assert.ok(signed.token.length < 120);
		const signedUrl = adminLoginUrl(server.url, signed.token);
		const cliLogin = await fetch(signedUrl, { redirect: "manual" });
		assert.equal(cliLogin.status, 303);
		assert.equal(cliLogin.headers.get("location"), "/admin");
		const cliReuse = await fetch(signedUrl, { redirect: "manual" });
		assert.equal(cliReuse.status, 401);
		const expired = createAdminLoginToken(
			readAdminSecret(stateRoot(root)),
			1,
			{ stateRoot: stateRoot(root) },
			Date.now() - 10_000,
		);
		const expiredLogin = await fetch(adminLoginUrl(server.url, expired.token), { redirect: "manual" });
		assert.equal(expiredLogin.status, 401);
		const tampered = `${signed.token.slice(0, -1)}${signed.token.endsWith("a") ? "b" : "a"}`;
		const tamperedLogin = await fetch(adminLoginUrl(server.url, tampered), { redirect: "manual" });
		assert.equal(tamperedLogin.status, 401);
		const parallel = createAdminLoginToken(readAdminSecret(stateRoot(root)), 300_000, { stateRoot: stateRoot(root) });
		const parallelUrl = adminLoginUrl(server.url, parallel.token);
		const parallelResults = await Promise.all([
			fetch(parallelUrl, { redirect: "manual" }),
			fetch(parallelUrl, { redirect: "manual" }),
		]);
		assert.deepEqual(parallelResults.map((response) => response.status).sort(), [303, 401]);

		const cookie = await login(logs);
		const access = await fetch(`${server.url}/admin/access`, { headers: { cookie }, redirect: "manual" });
		assert.equal(access.status, 303);
		assert.equal(access.headers.get("location"), "/admin/configuration");

		const routes = await fetch(`${server.url}/admin/routes`, { headers: { cookie }, redirect: "manual" });
		assert.equal(routes.status, 303);
		assert.equal(routes.headers.get("location"), "/admin/configuration");

		const webMint = await fetch(`${server.url}/admin/access/links`, {
			method: "POST",
			headers: {
				cookie,
				"content-type": "application/x-www-form-urlencoded",
				origin: server.url,
			},
			redirect: "manual",
		});
		assert.equal(webMint.status, 405);
	} finally {
		await app.stop();
		await rm(root, { recursive: true, force: true });
	}
});

test("admin manual secret signs links without generated state secret", async () => {
	const root = await mkdtemp(join(tmpdir(), "heypi-admin-manual-secret-"));
	const logs: LogEntry[] = [];
	const secret = "manual-admin-secret-with-enough-entropy-123";
	const app = createHeypi({
		store: sqliteStore({ path: join(root, "heypi.db") }),
		state: { root: stateRoot(root) },
		logger: captureLogger(logs),
		http: { port: 0 },
		admin: { secret, http: { port: 0 } },
		adapters: [],
		agent: loadAgent("../../examples/slack-devops/agent", { id: "default", model: "openai/gpt-5-mini" }),
		runtime: { name: "host-bash", root: workspace(join(root, "workspace")) },
	});
	try {
		await app.start();
		assert.equal(loginUrls(logs).length, 0);
		await assert.rejects(() => access(join(stateRoot(root), "admin", "secret")));
		const server = readAdminServerDescriptors(stateRoot(root))[0]?.descriptor;
		assert.ok(server);
		const signed = createAdminLoginToken(secret, 300_000, { stateRoot: stateRoot(root) });
		const response = await fetch(adminLoginUrl(server.url, signed.token), { redirect: "manual" });
		assert.equal(response.status, 303);
		assert.equal(response.headers.get("location"), "/admin");
	} finally {
		await app.stop();
		await rm(root, { recursive: true, force: true });
	}
});

test("admin manual secret must be strong even on loopback", async () => {
	const root = await mkdtemp(join(tmpdir(), "heypi-admin-weak-secret-"));
	const app = createHeypi({
		store: sqliteStore({ path: join(root, "heypi.db") }),
		state: { root: stateRoot(root) },
		logger: captureLogger([]),
		http: { port: 0 },
		admin: { secret: "weak", http: { port: 0 } },
		adapters: [],
		agent: loadAgent("../../examples/slack-devops/agent", { id: "default", model: "openai/gpt-5-mini" }),
		runtime: { name: "host-bash", root: workspace(join(root, "workspace")) },
	});
	try {
		await assert.rejects(() => app.start(), /admin secret must be at least 32 varied characters/);
	} finally {
		await app.stop();
		await rm(root, { recursive: true, force: true });
	}
});

test("admin login tokens are scoped to the state root", async () => {
	const root = await mkdtemp(join(tmpdir(), "heypi-admin-token-scope-"));
	const secret = "shared-admin-secret-with-enough-entropy-123";
	const appA = createHeypi({
		store: sqliteStore({ path: join(root, "a.db") }),
		state: { root: join(root, "a-state") },
		logger: captureLogger([]),
		http: { port: 0 },
		admin: { secret, http: { port: 0 } },
		adapters: [],
		agent: loadAgent("../../examples/slack-devops/agent", { id: "a", model: "openai/gpt-5-mini" }),
		runtime: { name: "host-bash", root: workspace(join(root, "a-workspace")) },
	});
	const appB = createHeypi({
		store: sqliteStore({ path: join(root, "b.db") }),
		state: { root: join(root, "b-state") },
		logger: captureLogger([]),
		http: { port: 0 },
		admin: { secret, http: { port: 0 } },
		adapters: [],
		agent: loadAgent("../../examples/slack-devops/agent", { id: "b", model: "openai/gpt-5-mini" }),
		runtime: { name: "host-bash", root: workspace(join(root, "b-workspace")) },
	});
	try {
		await appA.start();
		await appB.start();
		const serverB = readAdminServerDescriptors(join(root, "b-state"))[0]?.descriptor;
		assert.ok(serverB);
		const tokenA = createAdminLoginToken(secret, 300_000, { stateRoot: join(root, "a-state") });
		const rejected = await fetch(adminLoginUrl(serverB.url, tokenA.token), { redirect: "manual" });
		assert.equal(rejected.status, 401);
		const tokenB = createAdminLoginToken(secret, 300_000, { stateRoot: join(root, "b-state") });
		const accepted = await fetch(adminLoginUrl(serverB.url, tokenB.token), { redirect: "manual" });
		assert.equal(accepted.status, 303);
	} finally {
		await appB.stop();
		await appA.stop();
		await rm(root, { recursive: true, force: true });
	}
});

test("admin login token scope canonicalizes symlinked state roots", async () => {
	if (process.platform === "win32") return;
	const root = await mkdtemp(join(tmpdir(), "heypi-admin-scope-realpath-"));
	try {
		const real = join(root, "real-state");
		const linked = join(root, "linked-state");
		const secret = "admin-symlink-scope-secret-with-enough-entropy";
		await mkdir(real, { recursive: true });
		await symlink(real, linked, "dir");
		const signed = createAdminLoginToken(secret, 300_000, { stateRoot: linked });
		assert.equal(verifyAdminLoginToken(secret, signed.token, { stateRoot: real }).ok, true);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("admin memory page renders memory as escaped read-only text", async () => {
	const root = await mkdtemp(join(tmpdir(), "heypi-admin-memory-"));
	const port = await freePort();
	const logs: LogEntry[] = [];
	const runtimeRoot = join(root, "workspace");
	const memoryDir = join(runtimeRoot, "memory", "scopes", "manual");
	await mkdir(memoryDir, { recursive: true });
	await writeFile(join(memoryDir, "MEMORY.md"), "- <script>alert(1)</script>\n", "utf8");
	const app = createHeypi({
		store: sqliteStore({ path: join(root, "heypi.db") }),
		state: { root: stateRoot(root) },
		logger: captureLogger(logs),
		http: { port },
		admin: { http: { port } },
		adapters: [],
		memory: true,
		agent: loadAgent("../../examples/slack-devops/agent", { id: "default", model: "openai/gpt-5-mini" }),
		runtime: { name: "host-bash", root: workspace(runtimeRoot) },
	});
	try {
		await app.start();
		const cookie = await login(logs);
		const response = await fetch(`http://127.0.0.1:${port}/admin/memory`, { headers: { cookie } });
		assert.equal(response.status, 200);
		const body = await response.text();
		assert.match(body, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
		assert.doesNotMatch(body, /<script>alert\(1\)<\/script>/);
		assert.match(body, /Durable context files stored for future turns/);
		assert.doesNotMatch(body, /Memory is durable model context/);
		assert.doesNotMatch(body, /alert-destructive/);
		assert.doesNotMatch(body, /Settings/);
	} finally {
		await app.stop();
		await rm(root, { recursive: true, force: true });
	}
});

test("admin non-loopback binding can use generated signed link access", async () => {
	const root = await mkdtemp(join(tmpdir(), "heypi-admin-public-"));
	const port = await freePort();
	const logs: LogEntry[] = [];
	const app = createHeypi({
		store: sqliteStore({ path: join(root, "heypi.db") }),
		state: { root: stateRoot(root) },
		logger: captureLogger(logs),
		admin: { secureCookies: true, http: { host: "0.0.0.0", port } },
		adapters: [],
		agent: loadAgent("../../examples/slack-devops/agent", { id: "default", model: "openai/gpt-5-mini" }),
		runtime: { name: "host-bash", root: workspace(join(root, "workspace")) },
	});
	try {
		await app.start();
		assert.equal(loginUrls(logs).length, 0);
		const server = readAdminServerDescriptors(stateRoot(root))[0]?.descriptor;
		assert.ok(server);
		const signed = createAdminLoginToken(readAdminSecret(stateRoot(root)), 300_000, { stateRoot: stateRoot(root) });
		const response = await fetch(adminLoginUrl(server.url, signed.token), { redirect: "manual" });
		assert.equal(response.status, 303);
	} finally {
		await app.stop();
		await rm(root, { recursive: true, force: true });
	}
});

test("admin non-loopback binding requires secure cookies", async () => {
	const root = await mkdtemp(join(tmpdir(), "heypi-admin-public-insecure-"));
	const port = await freePort();
	const app = createHeypi({
		store: sqliteStore({ path: join(root, "heypi.db") }),
		state: { root: stateRoot(root) },
		logger: captureLogger([]),
		admin: { http: { host: "0.0.0.0", port } },
		adapters: [],
		agent: loadAgent("../../examples/slack-devops/agent", { id: "default", model: "openai/gpt-5-mini" }),
		runtime: { name: "host-bash", root: workspace(join(root, "workspace")) },
	});
	try {
		await assert.rejects(() => app.start(), /admin secureCookies must be enabled for non-loopback hosts/);
	} finally {
		await app.stop();
		await rm(root, { recursive: true, force: true });
	}
});

test("admin auth disabled rejects non-loopback binding", async () => {
	const root = await mkdtemp(join(tmpdir(), "heypi-admin-no-auth-public-"));
	const port = await freePort();
	const app = createHeypi({
		store: sqliteStore({ path: join(root, "heypi.db") }),
		state: { root: stateRoot(root) },
		logger: captureLogger([]),
		admin: { auth: false, http: { host: "0.0.0.0", port } },
		adapters: [],
		agent: loadAgent("../../examples/slack-devops/agent", { id: "default", model: "openai/gpt-5-mini" }),
		runtime: { name: "host-bash", root: workspace(join(root, "workspace")) },
	});
	try {
		await assert.rejects(() => app.start(), /admin auth can only be disabled on loopback hosts/);
	} finally {
		await app.stop();
		await rm(root, { recursive: true, force: true });
	}
});

function stateRoot(root: string): string {
	return join(root, "state");
}

async function login(logs: LogEntry[]): Promise<string> {
	const response = await fetch(loginUrl(logs), { redirect: "manual" });
	assert.equal(response.status, 303);
	return cookieHeader(response);
}

function loginUrl(logs: LogEntry[]): string {
	const url = loginUrls(logs)[0];
	if (typeof url !== "string") throw new Error("missing admin login link");
	return url;
}

function loginUrls(logs: LogEntry[]): string[] {
	return logs
		.filter((entry) => entry.event === "admin.login_link")
		.map((entry) => entry.input?.url)
		.filter((url): url is string => typeof url === "string");
}

function cookieHeader(response: Response): string {
	const value = response.headers.get("set-cookie");
	assert.ok(value);
	return value.split(";")[0];
}

async function firstEvent(url: string, cookie?: string): Promise<string> {
	const controller = new AbortController();
	const response = await fetch(url, { headers: cookie ? { cookie } : undefined, signal: controller.signal });
	assert.equal(response.status, 200);
	const reader = response.body?.getReader();
	if (!reader) throw new Error("missing event body");
	const chunk = await reader.read();
	controller.abort();
	if (!chunk.value) throw new Error("missing event chunk");
	return Buffer.from(chunk.value).toString("utf8");
}

function requiredMatch(input: string, pattern: RegExp): string {
	const match = input.match(pattern);
	if (!match?.[1]) throw new Error(`missing match: ${pattern}`);
	return match[1];
}

function captureLogger(logs: LogEntry[]): Logger {
	const write = (event: string, input?: Record<string, unknown>) => logs.push({ event, input });
	return {
		debug: write,
		info: write,
		warn: write,
		error: write,
	};
}

async function freePort(): Promise<number> {
	const server = createServer();
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
	if (!address || typeof address === "string") throw new Error("missing port");
	return address.port;
}

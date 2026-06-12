import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, rm, stat, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { agentFrom, consoleLogger, createHeypi, type Logger, sqliteStore, workspace } from "@hunvreus/heypi";
import type { Adapter } from "@hunvreus/heypi/adapter";
import {
	adminLoginUrl,
	createAdminLoginToken,
	readAdminSecret,
	readAdminServerDescriptors,
	verifyAdminLoginToken,
} from "../src/admin/auth.js";
import { createAdminService } from "../src/admin/service.js";
import { approvalsView, configurationView, jobsView, memoryView, threadsView } from "../src/admin/view.js";
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
		admin: { auth: false },
		adapters: [adapter],
		agent: agentFrom("../../examples/slack-devops/agent", { id: "default", model: "openai/gpt-5-mini" }),
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

		const threads = await service.threads();
		assert.deepEqual(
			threads.rows.map((row) => row.id),
			[ownThread.id],
		);
		assert.equal(threads.rows[0]?.summary, "deployment started");
		assert.equal(threads.rows[0]?.runningRuns, 0);
		const thread = await service.thread(ownThread.id, { event: `message:${inputMessage.id}` });
		assert.equal(thread?.selected?.id, inputMessage.id);
		const timeline = new Set(thread?.timeline.map((row) => `${row.kind}:${row.id}`));
		assert.equal(timeline.has(`message:${resultMessage.id}`), true);
		assert.equal(timeline.has(`run:${ownTurn.id}`), true);
		assert.equal(timeline.has(`message:${inputMessage.id}`), true);
		assert.equal(timeline.has(`approval:${ownApproval.id}`), true);
		assert.equal(timeline.has(`call:${ownCall.id}`), true);
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

test("admin configuration summarizes essentials with adapter icons", () => {
	const now = Date.now();
	const body = configurationView(
		{
			agent: { id: "agent", model: "openai/gpt-5-mini" },
			runtime: { name: "host-bash", root: "/tmp/workspace" },
			task: { busy: "followUp", cancel: "approver" },
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
	const body = approvalsView({
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
				snapshot: null,
				state: "pending",
				requestedBy: "U123",
				requestedAt: now - 30_000,
				expiresAt: now + (3 * 24 * 60 + 60) * 60 * 1000,
				resolvedAt: null,
				resolvedBy: null,
			},
		],
	});
	assert.match(body, />3d(?: \d+h)?</);
	assert.doesNotMatch(body, />in 3d</);
	assert.doesNotMatch(body, />3d ago</);
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
	const threadsBody = threadsView(
		{
			limit: 25,
			offset: 0,
			hasNext: false,
			rows: [threadRow],
		},
		{ checkedAt: now },
	);
	assert.match(threadsBody, />Chats<\/h2>/);
	assert.match(threadsBody, /Recent conversations across connected channels\./);
	assert.doesNotMatch(threadsBody, /role="tab"/);
	assert.match(threadsBody, /data-admin-chats/);
	assert.match(threadsBody, /data-admin-chats-card/);
	assert.match(threadsBody, /data-admin-chats-sidebar/);
	assert.match(threadsBody, /data-admin-chat-search/);
	assert.match(threadsBody, /type="search" name="q"[^>]+data-admin-chat-search-input/);
	assert.match(threadsBody, /aria-label="Search query"/);
	assert.match(threadsBody, /aria-label="Search chats"[^>]+data-admin-chat-search-submit/);
	assert.doesNotMatch(threadsBody, /pl-8/);
	assert.doesNotMatch(threadsBody, /absolute left-2\.5/);
	assert.doesNotMatch(threadsBody, /All states/);
	assert.doesNotMatch(threadsBody, /All channels/);
	assert.doesNotMatch(threadsBody, /All actors/);
	assert.doesNotMatch(threadsBody, />Filter<\/button>/);
	assert.match(threadsBody, /data-admin-chats-layout/);
	assert.match(threadsBody, /data-admin-thread-item data-thread-id="thread-1"/);
	assert.match(threadsBody, /data-admin-thread-channel>C123<\/span>/);
	assert.match(threadsBody, /data-admin-thread-preview>deploy api<\/span>/);
	assert.match(threadsBody, /data-admin-thread-updated/);
	assert.doesNotMatch(threadsBody, />Running<\/span>/);
	assert.match(threadsBody, /href="\/admin\/threads\/thread-1\?event=message%3Amessage-1"/);
	assert.match(threadsBody, /deploy api/);
	assert.doesNotMatch(threadsBody, /Message: deploy api/);
	assert.match(threadsBody, /Select a thread/);

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
		state: "done",
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
				timeline: [runEvent, callEvent, event, assistantEvent, emptyEvent],
				selected: callEvent,
				event: "call:call-1",
			},
		},
	);
	assert.match(threadBody, /data-tooltip="slack"/);
	assert.match(threadBody, /data-admin-thread-sticky-header/);
	assert.match(threadBody, /data-admin-thread-header/);
	assert.match(threadBody, /data-admin-thread-channel>C123<\/h2>/);
	assert.match(threadBody, /data-admin-thread-id>thread-1<\/span>/);
	assert.doesNotMatch(threadBody, /Channel C123 · Created /);
	assert.doesNotMatch(threadBody, / · Last updated /);
	assert.match(threadBody, /href="\/admin\/threads\/thread-1\?event=message%3Amessage-1"/);
	assert.match(threadBody, /aria-current="true"/);
	assert.match(threadBody, /data-selected-event="true"/);
	assert.match(threadBody, /data-admin-thread-scroll/);
	assert.match(threadBody, /data-admin-thread-list/);
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
	assert.match(threadBody, /<ul[^>]*><li>first check<\/li><\/ul>/);
	assert.match(
		threadBody,
		/<details id="event-call-call-1"[^>]+data-admin-context-row="call"[^>]+data-selected-event="true"/,
	);
	assert.match(threadBody, /data-admin-context-summary/);
	assert.match(threadBody, /data-admin-context-details/);
	assert.match(threadBody, />Runtime<\/span>/);
	assert.doesNotMatch(threadBody, />Stdout<\/span>/);
	assert.doesNotMatch(threadBody, />ID<\/div>/);
	assert.match(threadBody, /host_exec/);
	assert.doesNotMatch(threadBody, /tests passed/);
	assert.match(threadBody, /npm test/);
	assert.match(threadBody, /deploy api/);
	assert.doesNotMatch(threadBody, /Deployment queued/);
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
		admin: true,
		adapters: [],
		agent: agentFrom("../../examples/slack-devops/agent", { id: "default", model: "openai/gpt-5-mini" }),
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
		const header = body.match(/<header[\s\S]*?<\/header>/u)?.[0] ?? "";
		assert.ok(header.indexOf("Configuration") < header.indexOf("data-admin-nav-separator"));
		assert.ok(header.indexOf("data-admin-nav-separator") < header.indexOf('aria-label="Docs"'));
		assert.ok(header.indexOf('data-tooltip="Log out"') < header.indexOf("data-admin-theme-toggle"));
		assert.match(body, /<style nonce="[^"]+">\n\[data-admin-nav-mobile\]\{display:none\}/);
		assert.match(body, /\[data-admin-nav-desktop\]\{display:none!important\}/);
		assert.match(body, /\[data-admin-nav-mobile\]\{display:block!important\}/);
		assert.match(body, /data-admin-nav-desktop/);
		assert.match(body, /id="admin-mobile-menu" data-admin-nav-mobile/);
		assert.match(
			body,
			/id="admin-mobile-menu-trigger" aria-haspopup="menu" aria-controls="admin-mobile-menu-menu" aria-expanded="false"/,
		);
		assert.match(body, /aria-label="Open menu"[^>]+data-tooltip="Menu"[^>]+data-align="end"/);
		assert.match(body, /data-admin-mobile-menu-trigger/);
		assert.match(body, /data-admin-mobile-menu-popover/);
		assert.match(body, /role="menu" id="admin-mobile-menu-menu" aria-labelledby="admin-mobile-menu-trigger"/);
		assert.match(body, /data-admin-mobile-nav-link="chats" aria-current="page"/);
		assert.match(body, /Approvals<span[^>]+data-live-field="pendingApprovals">0<\/span>/);
		assert.match(body, /href="https:\/\/heypi\.dev\/docs"[^>]+data-admin-mobile-docs-link/);
		assert.match(body, /<button type="button" role="menuitem" data-admin-theme-toggle/);
		assert.match(body, /Toggle theme/);
		assert.match(body, /<button type="submit" role="menuitem"[^>]+data-admin-mobile-logout/);
		assert.match(body, /data-admin-theme-icon="moon"/);
		assert.match(body, /data-admin-theme-icon="sun"/);
		assert.match(body, /href="https:\/\/heypi\.dev\/docs"/);
		assert.match(body, /aria-label="Docs"/);
		assert.match(body, /data-tooltip="Docs"/);
		assert.match(body, /aria-label="Toggle theme"/);
		assert.match(body, /data-tooltip="Toggle theme"/);
		assert.match(body, /data-align="end"/);
		assert.doesNotMatch(body, /aria-current="false"/);
		assert.doesNotMatch(body, /data-tooltip="Toggle dark mode"/);
		assert.doesNotMatch(body, /title="Toggle dark mode"/);
		assert.match(body, /data-admin-main/);
		assert.match(body, /data-admin-page-title>Chats<\/h1>/);
		assert.match(body, /Recent conversations across connected channels\./);
		assert.doesNotMatch(body, /role="tablist"/);
		assert.doesNotMatch(body, /href="\/admin\/activity"/);
		assert.match(body, /Select a thread/);
		assert.doesNotMatch(body, /Chats<span/);
		assert.match(body, /data-admin-nav-link="chats" aria-current="page"/);
		assert.match(body, /data-admin-nav-link="approvals"/);
		assert.match(body, /data-admin-nav-link="jobs"/);
		assert.match(body, /data-admin-nav-link="memory"/);
		assert.match(body, /Approvals<span[^>]+data-live-field="pendingApprovals">0<\/span>/);
		assert.match(body, /Jobs<span[^>]+data-live-field="jobs">0<\/span>/);
		assert.match(body, /Memory<span[^>]*>0<\/span>/);
		assert.match(body, /href="\/admin\/configuration"[^>]*>Configuration/);
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
		admin: { auth: false },
		adapters: [],
		agent: agentFrom("../../examples/slack-devops/agent", { id: "default", model: "openai/gpt-5-mini" }),
		runtime: { name: "host-bash", root: workspace(join(root, "workspace")) },
	});
	try {
		await app.start();
		assert.deepEqual(loginUrls(logs), []);

		const adminPage = await fetch(`http://127.0.0.1:${port}/admin`, { redirect: "manual" });
		assert.equal(adminPage.status, 200);
		const body = await adminPage.text();
		assert.match(body, /heypi admin/);
		assert.doesNotMatch(body, /Log out/);

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
		admin: { auth: false },
		adapters: [],
		agent: agentFrom("../../examples/slack-devops/agent", { id: "default", model: "openai/gpt-5-mini" }),
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
		admin: true,
		adapters: [],
		agent: agentFrom("../../examples/slack-devops/agent", { id: "default", model: "openai/gpt-5-mini" }),
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
		admin: { secret },
		adapters: [],
		agent: agentFrom("../../examples/slack-devops/agent", { id: "default", model: "openai/gpt-5-mini" }),
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
		admin: { secret: "weak" },
		adapters: [],
		agent: agentFrom("../../examples/slack-devops/agent", { id: "default", model: "openai/gpt-5-mini" }),
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
		admin: { secret },
		adapters: [],
		agent: agentFrom("../../examples/slack-devops/agent", { id: "a", model: "openai/gpt-5-mini" }),
		runtime: { name: "host-bash", root: workspace(join(root, "a-workspace")) },
	});
	const appB = createHeypi({
		store: sqliteStore({ path: join(root, "b.db") }),
		state: { root: join(root, "b-state") },
		logger: captureLogger([]),
		http: { port: 0 },
		admin: { secret },
		adapters: [],
		agent: agentFrom("../../examples/slack-devops/agent", { id: "b", model: "openai/gpt-5-mini" }),
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
		admin: true,
		adapters: [],
		memory: true,
		agent: agentFrom("../../examples/slack-devops/agent", { id: "default", model: "openai/gpt-5-mini" }),
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
		http: { host: "0.0.0.0", port },
		admin: { secureCookies: true },
		adapters: [],
		agent: agentFrom("../../examples/slack-devops/agent", { id: "default", model: "openai/gpt-5-mini" }),
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
		http: { host: "0.0.0.0", port },
		admin: true,
		adapters: [],
		agent: agentFrom("../../examples/slack-devops/agent", { id: "default", model: "openai/gpt-5-mini" }),
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
		http: { host: "0.0.0.0", port },
		admin: { auth: false },
		adapters: [],
		agent: agentFrom("../../examples/slack-devops/agent", { id: "default", model: "openai/gpt-5-mini" }),
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

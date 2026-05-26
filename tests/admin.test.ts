import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { type Adapter, agentFrom, createHeypi, type Logger, sqliteStore, workspace } from "@hunvreus/heypi";
import { activityView, approvalsView, jobsView, memoryView, overviewView } from "../src/admin/view.js";

type LogEntry = {
	event: string;
	input?: Record<string, unknown>;
};

test("admin tables use Basecoat pagination markup", () => {
	const now = Date.now();
	const body = jobsView({
		limit: 50,
		offset: 50,
		hasNext: true,
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
	assert.match(body, /mt-4 flex w-full justify-end/);
	assert.match(body, /btn-sm-ghost/);
	assert.doesNotMatch(body, /Rows 51-51/);
	assert.doesNotMatch(body, /btn-icon-outline/);
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
		logger: captureLogger([]),
		http: { port },
		admin: { ...adminConfig(root), auth: false },
		adapters: [adapter],
		agent: agentFrom("./examples/slack-devops/agent", { id: "default", model: "openai/gpt-5-mini" }),
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
		assert.match(body, /<th>Route<\/th>/);
		assert.doesNotMatch(body, /"channels":\["C123"\]/);
	} finally {
		await app.stop();
		await rm(root, { recursive: true, force: true });
	}
});

test("admin configuration summarizes essentials with adapter icons", () => {
	const now = Date.now();
	const body = overviewView(
		{
			agent: { id: "agent", model: "openai/gpt-5-mini" },
			runtime: { name: "host-bash", root: "/tmp/workspace" },
			startedAt: now - 120_000,
			adapters: [
				{ name: "ops", kind: "slack" },
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
	assert.match(body, /Adapters/);
	assert.match(body, /title="slack"/);
	assert.match(body, /ops/);
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
	assert.match(body, /<h3 class="font-medium tracking-tight">No memory files<\/h3>/);
	assert.doesNotMatch(body, /text-lg font-medium tracking-tight/);
	assert.doesNotMatch(body, /mb-2 bg-muted/);
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
	assert.match(body, /<th class="pl-4">Scope<\/th>/);
	assert.match(body, /<th>Content<\/th>/);
	assert.match(body, /<th>Size<\/th>/);
	assert.match(body, /<th>Updated<\/th>/);
	assert.match(body, /<th>Hash<\/th>/);
	assert.match(body, /user\/U123/);
	assert.match(body, /max-w-\[34rem\] overflow-hidden text-ellipsis whitespace-nowrap/);
	assert.match(body, /0123456789ab/);
	assert.match(body, /data-admin-dialog-open="memory-detail-0"/);
	assert.match(body, /max-w-\[1040px\]/);
	assert.match(body, /Memory details/);
	assert.match(body, /aria-label="Copy scope"/);
	assert.match(body, /class="btn-sm-icon-ghost size-6 shrink-0 text-muted-foreground hover:text-foreground"/);
	assert.match(body, /aria-label="Copy path"/);
	assert.match(body, /aria-label="Copy SHA-256"/);
	assert.match(body, /aria-label="Copy content"/);
	assert.match(body, /data-admin-copy="\/tmp\/workspace\/memory\/scopes\/user\/U123\/MEMORY\.md"/);
	assert.match(
		body,
		/<span class="break-words \[overflow-wrap:anywhere\]">\/tmp\/workspace\/memory\/scopes\/user\/U123\/MEMORY\.md<\/span>/,
	);
	assert.match(body, />Content<\/div>/);
	assert.match(body, /<div class="max-w-full whitespace-pre-wrap break-words \[overflow-wrap:anywhere\]">/);
	assert.match(body, /<rect width="14" height="14" x="8" y="8" rx="2" ry="2"\/>/);
	assert.doesNotMatch(body, /whitespace-pre-wrap break-words font-mono/);
	assert.doesNotMatch(body, /<pre class=/);
	assert.match(body, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
	assert.doesNotMatch(body, /<script>alert\(1\)<\/script>/);
	assert.match(body, /aria-label="pagination"/);
});

test("admin activity table uses compact values and dialog details", () => {
	const now = Date.now();
	const body = activityView({
		limit: 25,
		offset: 0,
		hasNext: false,
		rows: [
			{
				id: "call-1",
				kind: "call",
				title: "host_exec",
				summary: "systemctl restart api",
				state: "blocked",
				channel: "slack::C123",
				actor: "U123",
				time: now - 60_000,
				durationMs: 1200,
			},
			{
				id: "run-1",
				kind: "run",
				title: "trace-1",
				summary: "slack/slack",
				state: "pending_approval",
				channel: "C123",
				actor: "U123",
				time: now - 120_000,
			},
			{
				id: "call-2",
				kind: "call",
				title: "host_exec",
				summary: "exit 1",
				state: "failed",
				channel: "slack::C123",
				actor: "U123",
				time: now - 180_000,
				durationMs: 300,
			},
		],
	});
	assert.doesNotMatch(body, /<th>Summary<\/th>/);
	assert.match(body, /<th class="pl-4">State<\/th>/);
	assert.match(body, /<th>Value<\/th>/);
	assert.match(body, /<th class="pr-4"><\/th>/);
	assert.match(body, /<span class="badge-secondary bg-amber-100 dark:bg-amber-900">Waiting approval<\/span>/);
	assert.match(body, /<span class="badge-secondary bg-amber-100 dark:bg-amber-900">Needs approval<\/span>/);
	assert.match(body, /<span class="badge-secondary bg-red-100 dark:bg-red-900">Failed<\/span>/);
	assert.match(body, /Tool call/);
	assert.match(body, /host_exec/);
	assert.match(body, /Waiting approval/);
	assert.match(body, /Needs approval/);
	assert.match(body, /data-tooltip=/);
	assert.match(body, /class="dialog/);
	assert.match(body, /w-\[calc\(100vw-2rem\)\]/);
	assert.match(body, /max-w-\[840px\]/);
	assert.match(body, /\[overflow-wrap:anywhere\]/);
	assert.match(body, /\[word-break:break-word\]/);
	assert.match(body, /overflow-y-auto overflow-x-hidden/);
	assert.doesNotMatch(body, /text-base leading-6 text-muted-foreground/);
	assert.match(body, /btn-sm-ghost/);
	assert.match(body, /data-admin-dialog-open=/);
	assert.match(body, /data-admin-dialog-close/);
	assert.match(body, /aria-label="Copy ID"/);
	assert.match(body, /aria-label="Copy actor"/);
	assert.match(body, /aria-label="Copy channel"/);
	assert.match(body, /data-admin-copy="call-1"/);
	assert.doesNotMatch(body, /<footer><button class="btn-outline" data-admin-dialog-close>Close<\/button><\/footer>/);
	assert.doesNotMatch(body, /onclick=/);
	assert.match(body, /Activity details/);
	assert.match(body, /systemctl restart api/);
});

test("admin one-time login issues a session and logout requires CSRF", async () => {
	const root = await mkdtemp(join(tmpdir(), "heypi-admin-auth-"));
	const port = await freePort();
	const logs: LogEntry[] = [];
	const app = createHeypi({
		store: sqliteStore({ path: join(root, "heypi.db") }),
		logger: captureLogger(logs),
		http: { port },
		admin: adminConfig(root),
		adapters: [],
		agent: agentFrom("./examples/slack-devops/agent", { id: "default", model: "openai/gpt-5-mini" }),
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
		assert.match(loginBody, /inline-flex items-center/);
		assert.match(loginBody, /opacity-50/);

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
		assert.match(reusedBody, /min-h-\[calc\(100vh-2rem\)\]/);
		assert.doesNotMatch(reusedBody, /data-admin-theme-toggle/);

		const adminPage = await fetch(`http://127.0.0.1:${port}/admin`, { headers: { cookie } });
		assert.equal(adminPage.status, 200);
		const body = await adminPage.text();
		assert.match(body, /heypi admin/);
		assert.match(body, /aria-label="heypi"/);
		assert.match(body, /h-4/);
		assert.match(body, /btn-icon-ghost/);
		assert.match(
			body,
			/<a class="btn-ghost" href="https:\/\/heypi\.dev\/docs" target="_blank" rel="noopener noreferrer">Docs<\/a>/,
		);
		assert.match(body, /href="https:\/\/heypi\.dev\/docs"/);
		assert.doesNotMatch(body, /data-tooltip="Toggle dark mode"/);
		assert.doesNotMatch(body, /title="Toggle dark mode"/);
		assert.match(body, /max-w-7xl/);
		assert.match(body, /<h1 class="sr-only">Activity<\/h1>/);
		assert.match(body, /role="tablist"/);
		assert.match(body, /aria-selected="true" class="min-w-0 inline-flex items-center gap-2" href="\/admin">Activity/);
		assert.match(
			body,
			/Approvals<span class="badge-secondary bg-black\/10 dark:bg-black\/20 h-4 px-1\.5 text-\[11px\]" data-live-field="pendingApprovals">0<\/span>/,
		);
		assert.match(
			body,
			/Memory<span class="badge-secondary bg-black\/10 dark:bg-black\/20 h-4 px-1\.5 text-\[11px\]">0<\/span>/,
		);
		assert.doesNotMatch(body, /badge-secondary font-mono/);
		assert.match(body, /href="\/admin\/configuration">Configuration/);
		assert.match(body, /ml-auto min-w-0/);
		assert.doesNotMatch(body, /Agent folder/);
		assert.doesNotMatch(body, /Uptime/);
		assert.doesNotMatch(body, /Admin auth/);
		assert.doesNotMatch(body, /Cookies/);
		assert.doesNotMatch(body, /Threads/);
		assert.doesNotMatch(body, /Pending approvals/);
		assert.match(body, /\/admin\/approvals/);
		assert.match(body, /\/admin\/jobs/);
		assert.match(body, /\/admin\/memory/);
		assert.match(body, /\/admin\/configuration/);
		assert.doesNotMatch(body, /\/admin\/access/);
		assert.doesNotMatch(body, /\/admin\/routes/);
		assert.match(body, /text-muted-foreground/);
		assert.match(body, /prefers-color-scheme: dark/);
		assert.match(body, /localStorage\.getItem\("themeMode"\)/);
		assert.match(body, /basecoat:theme/);
		assert.match(body, /data-admin-theme-toggle/);
		assert.doesNotMatch(body, /data-admin-theme-toggle class="btn-icon-ghost size-8"/);
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
		assert.match(configBody, /<h1 class="sr-only">Configuration<\/h1>/);
		assert.match(configBody, /Agent/);
		assert.match(configBody, /Model/);
		assert.match(configBody, /Runtime/);
		assert.match(configBody, /HTTP/);
		assert.match(configBody, /Adapters/);
		assert.match(configBody, /Memory/);
		assert.match(configBody, /Started/);
		assert.match(configBody, /ago \(/);
		assert.doesNotMatch(configBody, /Uptime/);

		const empty = await fetch(`http://127.0.0.1:${port}/admin/activity`, { headers: { cookie } });
		assert.equal(empty.status, 200);
		const emptyBody = await empty.text();
		assert.match(emptyBody, /No activity yet/);
		assert.match(emptyBody, /Once the agent starts handling messages/);
		assert.match(emptyBody, /border-dashed/);
		assert.doesNotMatch(emptyBody, /min-h-\[calc\(100vh-11rem\)\]/);
		assert.doesNotMatch(emptyBody, /mb-2 bg-muted/);

		const jobs = await fetch(`http://127.0.0.1:${port}/admin/jobs`, { headers: { cookie } });
		assert.equal(jobs.status, 200);
		const jobsBody = await jobs.text();
		assert.match(jobsBody, /No jobs configured/);
		assert.match(jobsBody, /Once scheduled or heartbeat jobs are configured/);
		assert.doesNotMatch(jobsBody, /mb-2 bg-muted/);

		const missing = await fetch(`http://127.0.0.1:${port}/admin/missing`, { headers: { cookie } });
		assert.equal(missing.status, 404);
		const missingBody = await missing.text();
		assert.match(missingBody, /Page not found/);
		assert.match(missingBody, /More about heypi/);
		assert.match(missingBody, /https:\/\/heypi\.dev\/docs/);
		assert.match(missingBody, /btn-sm-outline/);
		assert.match(missingBody, /target="_blank"/);
		assert.match(missingBody, /inline-flex items-center/);
		assert.match(missingBody, /opacity-50/);
		assert.match(missingBody, /min-h-\[calc\(100vh-2rem\)\]/);
		assert.doesNotMatch(missingBody, /border-dashed/);
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
		logger: captureLogger(logs),
		http: { port },
		admin: { ...adminConfig(root), auth: false },
		adapters: [],
		agent: agentFrom("./examples/slack-devops/agent", { id: "default", model: "openai/gpt-5-mini" }),
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

test("admin control endpoint mints fresh one-time login links", async () => {
	const root = await mkdtemp(join(tmpdir(), "heypi-admin-link-"));
	const port = await freePort();
	const logs: LogEntry[] = [];
	const app = createHeypi({
		store: sqliteStore({ path: join(root, "heypi.db") }),
		logger: captureLogger(logs),
		http: { port },
		admin: adminConfig(root),
		adapters: [],
		agent: agentFrom("./examples/slack-devops/agent", { id: "default", model: "openai/gpt-5-mini" }),
		runtime: { name: "host-bash", root: workspace(join(root, "workspace")) },
	});
	try {
		await app.start();
		const denied = await fetch(`http://127.0.0.1:${port}/admin/_control/links`, { method: "POST" });
		assert.equal(denied.status, 401);

		const control = await controlFile(root);
		const mintedByCli = await fetch(`http://127.0.0.1:${port}/admin/_control/links`, {
			method: "POST",
			headers: { authorization: `Bearer ${control.token}` },
		});
		assert.equal(mintedByCli.status, 200);
		const cliLink = (await mintedByCli.json()) as { url?: string; expiresAt?: number };
		assert.ok(cliLink.url);
		assert.ok(cliLink.expiresAt);
		const cliLogin = await fetch(cliLink.url, { redirect: "manual" });
		assert.equal(cliLogin.status, 303);
		assert.equal(cliLogin.headers.get("location"), "/admin");
		const cliReuse = await fetch(cliLink.url, { redirect: "manual" });
		assert.equal(cliReuse.status, 401);

		const cookie = await login(logs);
		const access = await fetch(`http://127.0.0.1:${port}/admin/access`, { headers: { cookie }, redirect: "manual" });
		assert.equal(access.status, 303);
		assert.equal(access.headers.get("location"), "/admin/configuration");

		const routes = await fetch(`http://127.0.0.1:${port}/admin/routes`, { headers: { cookie }, redirect: "manual" });
		assert.equal(routes.status, 303);
		assert.equal(routes.headers.get("location"), "/admin/configuration");

		const webMint = await fetch(`http://127.0.0.1:${port}/admin/access/links`, {
			method: "POST",
			headers: {
				cookie,
				"content-type": "application/x-www-form-urlencoded",
				origin: `http://127.0.0.1:${port}`,
			},
			redirect: "manual",
		});
		assert.equal(webMint.status, 405);
	} finally {
		await app.stop();
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
		logger: captureLogger(logs),
		http: { port },
		admin: adminConfig(root),
		adapters: [],
		memory: true,
		agent: agentFrom("./examples/slack-devops/agent", { id: "default", model: "openai/gpt-5-mini" }),
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

test("admin non-loopback binding can use generated control-token link access", async () => {
	const root = await mkdtemp(join(tmpdir(), "heypi-admin-public-"));
	const port = await freePort();
	const app = createHeypi({
		store: sqliteStore({ path: join(root, "heypi.db") }),
		logger: captureLogger([]),
		http: { host: "0.0.0.0", port },
		admin: adminConfig(root),
		adapters: [],
		agent: agentFrom("./examples/slack-devops/agent", { id: "default", model: "openai/gpt-5-mini" }),
		runtime: { name: "host-bash", root: workspace(join(root, "workspace")) },
	});
	try {
		await app.start();
		await app.stop();
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("admin auth disabled rejects non-loopback binding", async () => {
	const root = await mkdtemp(join(tmpdir(), "heypi-admin-no-auth-public-"));
	const port = await freePort();
	const app = createHeypi({
		store: sqliteStore({ path: join(root, "heypi.db") }),
		logger: captureLogger([]),
		http: { host: "0.0.0.0", port },
		admin: { ...adminConfig(root), auth: false },
		adapters: [],
		agent: agentFrom("./examples/slack-devops/agent", { id: "default", model: "openai/gpt-5-mini" }),
		runtime: { name: "host-bash", root: workspace(join(root, "workspace")) },
	});
	try {
		await assert.rejects(() => app.start(), /admin auth can only be disabled on loopback hosts/);
	} finally {
		await app.stop();
		await rm(root, { recursive: true, force: true });
	}
});

function adminConfig(root: string): { controlPath: string } {
	return { controlPath: join(root, "admin-control.json") };
}

async function controlFile(root: string): Promise<{ token: string; url: string }> {
	return JSON.parse(await readFile(join(root, "admin-control.json"), "utf8")) as { token: string; url: string };
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

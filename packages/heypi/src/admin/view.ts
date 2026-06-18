import { actorGroups, actorUsers } from "../core/approvers.js";
import type { Approval, ApprovalBypass } from "../store/types.js";
import {
	type AdminActivityDetail,
	type AdminActivityRow,
	type AdminEval,
	type AdminFilterFacets,
	type AdminJob,
	type AdminMemory,
	type AdminOverview,
	type AdminPage,
	type AdminPageFilters,
	type AdminThreadRow,
	type AdminThreadView,
	activityEvent,
} from "./service.js";

export type PageInput = {
	title: string;
	active: string;
	csrf: string;
	auth?: boolean;
	live: AdminOverview["live"];
	memoryFiles: number;
	body: string;
	nonce: string;
	livePage?: boolean;
	liveThreadId?: string;
};

export type ErrorPageInput = {
	title: string;
	message: string;
	nonce: string;
	status?: number;
	actionHref?: string;
	actionLabel?: string;
};

type AdminInfo = {
	host: string;
	port: number | string;
};

type Cell = string | { html: string };
type CardDescription = string | Cell;
const ADMIN_CSS_HREF = "/admin/assets/admin.css?v=8";
const ADMIN_JS_HREF = "/admin/assets/basecoat.all.min.js?v=1";
const ADMIN_DOCS_HREF = "https://heypi.dev/docs";

export function page(input: PageInput): string {
	const mainClass = "mx-auto grid min-w-0 w-full max-w-7xl gap-4 px-6 py-3 max-[760px]:px-4 max-[760px]:py-3";
	return `<!doctype html>
<html lang="en" class="overflow-x-hidden">
<head>
${themeScript(input.nonce, true)}
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(input.title)} · heypi admin</title>
<link rel="stylesheet" href="${ADMIN_CSS_HREF}">
${navBreakpointStyle(input.nonce)}
</head>
<body class="min-h-screen overflow-x-hidden bg-background text-foreground" data-live-page="${input.livePage ? "true" : "false"}" data-live-revision="${escapeHtml(input.live.revision)}" data-live-chats-revision="${escapeHtml(input.live.chatsRevision)}" data-live-thread-id="${escapeHtml(input.liveThreadId ?? "")}" data-live-thread-revision="${escapeHtml(input.liveThreadId ? (input.live.threadRevisions[input.liveThreadId] ?? "") : "")}">
	<header class="bg-background" data-admin-app-header>
	<div class="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-3 px-6 py-3 max-[760px]:px-4">
	<a class="flex items-center text-foreground" href="/admin" aria-label="heypi">${logo("h-4 w-auto")}</a>
	${topNav(input.active, input.live, input.memoryFiles, input.csrf, input.auth)}
	</div>
	</header>
	<main class="${mainClass}" data-admin-main>
	<h1 class="sr-only" data-admin-page-title>${escapeHtml(input.title)}</h1>
${input.body}
</main>
<script src="${ADMIN_JS_HREF}" defer></script>
<script nonce="${escapeHtml(input.nonce)}">
let currentRevision = document.body.dataset.liveRevision || undefined;
let currentChatsRevision = document.body.dataset.liveChatsRevision || undefined;
let currentThreadRevision = document.body.dataset.liveThreadRevision || undefined;
const livePage = document.body.dataset.livePage === "true";
const liveThreadId = document.body.dataset.liveThreadId || "";
const fields = {
	pendingApprovals: document.querySelectorAll('[data-live-field="pendingApprovals"]'),
	runningRuns: document.querySelectorAll('[data-live-field="runningRuns"]'),
	jobs: document.querySelectorAll('[data-live-field="jobs"]'),
	activeJobs: document.querySelectorAll('[data-live-field="activeJobs"]'),
	pausedJobs: document.querySelectorAll('[data-live-field="pausedJobs"]'),
	recentCalls: document.querySelectorAll('[data-live-field="recentCalls"]'),
	checkedAt: document.querySelectorAll('[data-live-field="checkedAt"]')
};
function updateField(name, value) {
	for (const el of fields[name] || []) el.textContent = String(value);
}
function markCopied(button, previous) {
	button.setAttribute("aria-label", "Copied");
	const original = button.dataset.adminCopyIcon ?? button.innerHTML;
	button.dataset.adminCopyIcon = original;
	button.innerHTML = '${icon("check")}';
	setTimeout(() => {
		button.setAttribute("aria-label", previous);
		button.innerHTML = original;
	}, 1500);
}
function fallbackCopy(text) {
	const textarea = document.createElement("textarea");
	textarea.value = text;
	textarea.setAttribute("readonly", "");
	textarea.style.position = "fixed";
	textarea.style.left = "-9999px";
	document.body.append(textarea);
	textarea.select();
	const copied = document.execCommand("copy");
	textarea.remove();
	return copied;
}
function threadScrollContainer() {
	return document.querySelector("[data-admin-thread-scroll]");
}
function threadScrollKey() {
	return "heypi:admin:thread-scroll:" + location.pathname + location.search;
}
function threadAtBottom(container) {
	return container.scrollHeight - container.scrollTop - container.clientHeight <= 24;
}
function threadScrollBottom(container) {
	container.scrollTop = container.scrollHeight;
}
const threadScroll = threadScrollContainer();
let threadFollowBottom = true;
if (threadScroll instanceof HTMLElement) {
	requestAnimationFrame(() => {
		requestAnimationFrame(() => {
			const stored = sessionStorage.getItem(threadScrollKey());
			sessionStorage.removeItem(threadScrollKey());
			if (stored && stored !== "bottom") threadScroll.scrollTop = Number(stored) || 0;
			else threadScrollBottom(threadScroll);
			threadFollowBottom = threadAtBottom(threadScroll);
		});
	});
	threadScroll.addEventListener("scroll", () => {
		threadFollowBottom = threadAtBottom(threadScroll);
	}, { passive: true });
	new MutationObserver(() => {
		if (threadFollowBottom) requestAnimationFrame(() => threadScrollBottom(threadScroll));
	}).observe(threadScroll, { childList: true, subtree: true });
}
const events = new EventSource("/admin/events");
events.addEventListener("summary", (event) => {
	const data = JSON.parse(event.data);
	updateField("pendingApprovals", data.pendingApprovals);
	updateField("runningRuns", data.runningRuns);
	updateField("jobs", data.jobs);
	updateField("activeJobs", data.activeJobs);
	updateField("pausedJobs", data.pausedJobs);
	updateField("recentCalls", data.recentCalls);
	updateField("checkedAt", "Last updated " + new Date(data.checkedAt).toLocaleTimeString());
	if (currentRevision && data.revision !== currentRevision && livePage) {
		const nextThreadRevision = liveThreadId ? data.threadRevisions?.[liveThreadId] : undefined;
		const chatsChanged = Boolean(data.chatsRevision && data.chatsRevision !== currentChatsRevision);
		const shouldReload = liveThreadId
			? chatsChanged || Boolean(nextThreadRevision && nextThreadRevision !== currentThreadRevision)
			: true;
		if (data.chatsRevision) currentChatsRevision = data.chatsRevision;
		if (nextThreadRevision) currentThreadRevision = nextThreadRevision;
		if (shouldReload) {
			const container = threadScrollContainer();
			if (container instanceof HTMLElement) {
				sessionStorage.setItem(threadScrollKey(), threadAtBottom(container) ? "bottom" : String(container.scrollTop));
			}
			setTimeout(() => location.reload(), 750);
		}
	}
	currentRevision = data.revision;
});
events.addEventListener("auth", () => {
	events.close();
	location.href = "/admin/login";
});
events.onerror = () => updateField("checkedAt", "Last update unavailable");
document.addEventListener("click", (event) => {
	const target = event.target;
	if (!(target instanceof Element)) return;
	const copy = target.closest("[data-admin-copy]");
	if (copy instanceof HTMLElement) {
		const text = copy.dataset.adminCopy ?? "";
		const previous = copy.getAttribute("aria-label") ?? "Copy";
		const write = navigator.clipboard?.writeText(text);
		if (!write) {
			if (fallbackCopy(text)) markCopied(copy, previous);
			return;
		}
		void write.then(() => markCopied(copy, previous)).catch(() => {
			if (fallbackCopy(text)) markCopied(copy, previous);
		});
		return;
	}
	const opener = target.closest("[data-admin-dialog-open]");
	if (opener instanceof HTMLElement) {
		const id = opener.dataset.adminDialogOpen;
		if (id) document.getElementById(id)?.showModal();
		return;
	}
	if (target instanceof HTMLDialogElement && target.matches("[data-admin-dialog]")) {
		target.close();
		return;
	}
	const closer = target.closest("[data-admin-dialog-close]");
	if (closer) closer.closest("dialog")?.close();
});
</script>
</body>
</html>`;
}

function logoutForm(csrf: string): string {
	return `<form method="post" action="/admin/logout" class="contents">
	<input type="hidden" name="csrf" value="${escapeHtml(csrf)}">
		<button class="btn-sm-icon-ghost text-muted-foreground hover:text-foreground" type="submit" aria-label="Log out" data-admin-logout data-tooltip="Log out" data-side="bottom">${icon("log-out")}</button>
	</form>`;
}

function navBreakpointStyle(nonce: string): string {
	return `<style nonce="${escapeHtml(nonce)}">
[data-admin-nav-mobile]{display:none}
@media (max-width:760px){
	[data-admin-nav-desktop]{display:none!important}
	[data-admin-nav-mobile]{display:block!important}
}
</style>`;
}

export function loginPage(input: { error?: string; secret: boolean; nonce: string }): string {
	const title = input.error ? "Admin access failed" : "Admin access only";
	const message =
		input.error ?? (input.secret ? "Enter the configured admin secret." : "Use a valid one-time login link.");
	const actionHtml = input.secret
		? `<form class="form grid w-full gap-4" method="post" action="/admin/login"><div class="grid gap-2 text-left"><label for="secret">Admin secret</label><input id="secret" type="password" name="secret" autocomplete="current-password" autofocus></div><button class="btn-sm" type="submit">Log in</button></form>`
		: docsAction();
	return `<!doctype html>
<html lang="en" class="overflow-x-hidden">
<head>
${themeScript(input.nonce)}
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>heypi admin login</title>
<link rel="stylesheet" href="${ADMIN_CSS_HREF}">
</head>
<body class="grid min-h-screen place-items-center bg-background p-4 text-foreground">
<main class="w-full max-w-[40rem]">
${emptyState({ title, message, actionHtml, frame: "page", variant: "plain" })}
</main>
</body>
</html>`;
}

export function errorPage(input: ErrorPageInput): string {
	const status = input.status ? `${input.status} · ` : "";
	return `<!doctype html>
<html lang="en" class="overflow-x-hidden">
<head>
${themeScript(input.nonce)}
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(input.title)} · heypi admin</title>
<link rel="stylesheet" href="${ADMIN_CSS_HREF}">
</head>
<body class="grid min-h-screen place-items-center bg-background p-4 text-foreground">
<main class="w-full max-w-[40rem]">
${emptyState({
	title: `${status}${input.title}`,
	message: input.message,
	actionHref: input.actionHref ?? ADMIN_DOCS_HREF,
	actionLabel: input.actionLabel ?? "More about heypi",
	frame: "page",
	variant: "plain",
})}
</main>
</body>
</html>`;
}

export function configurationView(input: AdminOverview, admin: AdminInfo): string {
	const uptime = Math.max(Date.now() - input.startedAt, 0);
	const memory = memorySummary(input.memory);
	const activeBypasses = bypassList(input.activeBypasses);
	return `<div class="grid min-w-0 gap-4">
${card(
	"Configuration",
	checkedAtDescription("Configuration and process details for this heypi instance.", input.live.checkedAt),
	summaryList(
		[
			["Agent", mono(input.agent.id)],
			["Model", mono(input.agent.model ?? "-")],
			["Runtime", mono(input.runtime.name)],
			["HTTP", mono(`${admin.host}:${admin.port}`)],
			["Task", taskSummary(input.task)],
			["Approval", approvalSummary(input)],
			["Adapters", adapterList(input.adapters)],
			["Active bypasses", activeBypasses],
			["Memory", memory],
			["Started", `${duration(uptime)} ago (${time(input.startedAt)})`],
		],
		"text-sm md:grid-cols-2",
		true,
	),
)}
</div>`;
}

export function threadsView(
	page: AdminPage<AdminThreadRow>,
	input: { checkedAt?: number; selected?: AdminThreadView; csrf?: string } = {},
): string {
	const selectedId = input.selected?.thread.id;
	return `<div class="grid h-[calc(100vh-5.5rem)] min-w-0" data-admin-chats>
	<div class="card !p-0 flex h-full min-h-0 min-w-0 flex-col overflow-hidden" data-admin-chats-card>
	<div class="grid min-h-0 min-w-0 flex-1 grid-rows-[auto_minmax(0,1fr)] lg:grid-cols-[minmax(17rem,22rem)_minmax(0,1fr)] lg:grid-rows-1" data-admin-chats-layout>
	<aside class="flex max-h-[36vh] min-h-0 min-w-0 flex-col gap-3 overflow-hidden border-b p-4 lg:max-h-none lg:border-b-0" data-admin-chats-sidebar>
	<header class="grid gap-3">
		<div class="grid gap-1">
			<h2 class="leading-none font-semibold">Chats</h2>
			<p class="text-sm text-muted-foreground">Recent conversations across connected channels.</p>
		</div>
		${threadSearch(page)}
	</header>
		<div class="scrollbar min-h-0 min-w-0 flex-1 overflow-x-hidden overflow-y-auto" data-admin-thread-list>${threadList(page, selectedId)}</div>
		${adminComposeForm({ csrf: input.csrf, compact: true })}
	</aside>
	<section class="min-h-0 min-w-0 overflow-hidden lg:border-l" data-admin-thread-panel>${threadConversationPanel(input.selected, input.csrf)}</section>
</div>
</div>
</div>`;
}

function threadSearch(page: AdminPage<AdminThreadRow>): string {
	const q = page.filters?.q ?? "";
	const provider = page.filters?.provider ?? "";
	const reset = activeFilters(page.filters)
		? `<a class="btn-sm-ghost h-8 shrink-0" href="/admin" data-admin-chat-filter-reset>Reset</a>`
		: "";
	return `<form class="min-w-0" method="get" action="/admin" data-admin-chat-search>
	<input type="hidden" name="limit" value="${page.limit}">
	<div class="flex min-w-0 items-center gap-2">
	<div class="relative min-w-0 flex-1">
			<input type="search" name="q" class="input h-8 pr-9 text-sm" placeholder="Search..." value="${escapeHtml(q)}" aria-label="Search query" data-admin-chat-search-input>
			<button class="absolute right-1.5 top-1/2 -translate-y-1/2 btn-icon-ghost text-muted-foreground hover:text-accent-foreground size-6" type="submit" aria-label="Search chats" data-admin-chat-search-submit data-tooltip="Search chats" data-side="top" data-align="end">${icon("search")}</button>
	</div>
	<select class="select h-8 w-[8.5rem] shrink-0 py-1 text-sm" name="provider" aria-label="Adapter" data-admin-chat-provider-filter>
		<option value="">All adapters</option>
		${(page.facets?.providers ?? [])
			.map((value) => `<option value="${escapeHtml(value)}"${value === provider ? " selected" : ""}>${escapeHtml(adapterLabel(value))}</option>`)
			.join("")}
	</select>
	${reset}
	</div>
</form>${scanNotice(page)}`;
}

export function approvalsView(page: AdminPage<Approval>, checkedAt?: number, input: { csrf?: string } = {}): string {
	const body = `${tableControls("/admin/approvals", page, {
		comboboxes: [
			{
				name: "channel",
				label: "Channel",
				allLabel: "All channels",
				options: page.facets?.channels ?? [],
			},
			{
				name: "actor",
				label: "Requester",
				allLabel: "All requesters",
				options: page.facets?.actors ?? [],
			},
		],
	})}${table(
		["State", "Command", "Channel", "Runtime", "Reason", "Requested", "Expires", "Actions"],
		page.rows.map((row) => [
			statusBadge(row.state),
			{
				html: `<span class="block max-w-[34rem] overflow-hidden text-ellipsis whitespace-nowrap font-mono text-[13px] max-[760px]:max-w-[18rem]">${escapeHtml(row.command)}</span>`,
			},
			muted(row.channel),
			muted(row.runtime),
			muted(row.reason),
			mutedHtml(relativeTimeHtml(row.requestedAt)),
			mutedHtml(futureTimeHtml(row.expiresAt)),
			{ html: approvalActions(row, input.csrf) },
		]),
		emptyStateForFilters(page.filters, {
			title: "No pending approvals",
			message: "Once a tool call needs a human decision, the pending request will show up here.",
		}),
	)}${pagination("/admin/approvals", page)}`;
	return `<div class="grid min-w-0 gap-4">${card("Approvals", checkedAtDescription("Pending human decisions for approval-gated tool calls.", checkedAt), body)}</div>`;
}

function approvalActions(row: Approval, csrf?: string): string {
	if (csrf === undefined) return cellHtml(muted("-"));
	const actor = "admin";
	return `<form method="post" action="/admin/approvals" class="flex min-w-max items-center gap-1.5" data-admin-approval-actions="${escapeHtml(row.id)}">
	<input type="hidden" name="csrf" value="${escapeHtml(csrf)}">
	<input type="hidden" name="id" value="${escapeHtml(row.id)}">
	<label class="sr-only" for="approval-actor-${escapeHtml(row.id)}">Approval actor</label>
	<input id="approval-actor-${escapeHtml(row.id)}" class="input h-8 w-[9rem] text-sm" name="actor" value="${escapeHtml(actor)}" aria-label="Approval actor">
	<button class="btn-sm-icon-ghost text-muted-foreground hover:text-foreground" type="submit" name="action" value="approve" aria-label="Approve ${escapeHtml(row.id)}" data-tooltip="Approve" data-side="top">${icon("check")}</button>
	<button class="btn-sm-icon-ghost text-muted-foreground hover:text-foreground" type="submit" name="action" value="deny" aria-label="Deny ${escapeHtml(row.id)}" data-tooltip="Deny" data-side="top">${icon("x")}</button>
</form>`;
}

export function jobsView(page: AdminPage<AdminJob>, checkedAt?: number): string {
	const body = `${tableControls("/admin/jobs", page, {
		selects: [
			{
				name: "type",
				label: "Type",
				allLabel: "All types",
				options: [
					["cron", "Cron"],
					["heartbeat", "Heartbeat"],
				],
			},
			{
				name: "state",
				label: "State",
				allLabel: "All states",
				options: [
					["active", "Active"],
					["paused", "Paused"],
				],
			},
		],
	})}${table(
		["State", "Job", "Kind", "Route", "Schedule", "Next", "Last", "Prompt"],
		page.rows.map((row) => [
			statusBadge(row.state),
			mono(row.id),
			muted(row.kind),
			row.route ? truncatedText(row.route) : muted("-"),
			muted(scheduleText(row)),
			mutedHtml(timeHintHtml(row.nextAt, "Not scheduled")),
			mutedHtml(timeHintHtml(row.lastAt, "Never")),
			{
				html: `<div class="max-w-[34rem] overflow-hidden text-ellipsis whitespace-nowrap text-muted-foreground max-[760px]:max-w-[18rem]">${escapeHtml(row.prompt)}</div>`,
			},
		]),
		emptyStateForFilters(page.filters, {
			title: "No jobs configured",
			message: "Once scheduled or heartbeat jobs are configured on the heypi app, they will show up here.",
		}),
	)}${pagination("/admin/jobs", page)}`;
	return `<div class="grid min-w-0 gap-4">${card("Jobs", checkedAtDescription("Configured scheduled and heartbeat jobs.", checkedAt), body)}</div>`;
}

export function evalsView(page: AdminPage<AdminEval>, checkedAt?: number): string {
	const body = `${tableControls("/admin/evals", page)}${table(
		["Eval", "Tags", "Expectation", "Timeout", "Prompt", ""],
		page.rows.map((row, index) => [
			mono(row.name),
			muted(row.tags.length ? row.tags.join(", ") : "-"),
			muted(row.expect),
			muted(row.timeoutMs ? duration(row.timeoutMs) : "-"),
			truncatedText(row.prompt),
			evalDetails(row, index),
		]),
		emptyStateForFilters(page.filters, {
			title: "No evals configured",
			message: "Add eval definitions under agent/evals/ to inspect behavior checks here.",
		}),
	)}${pagination("/admin/evals", page)}`;
	return `<div class="grid min-w-0 gap-4">${card("Evals", checkedAtDescription("Loaded agent behavior eval definitions.", checkedAt), body)}</div>`;
}

export function memoryView(memory: AdminMemory, checkedAt?: number): string {
	if (!memory.enabled) {
		const body = emptyState({
			title: "Memory disabled",
			message:
				"This heypi app is running without durable memory. Enable memory in the app config to store context files.",
			frame: "section",
			variant: "outline",
		});
		return `<div class="grid min-w-0 gap-4">${card("Memory", checkedAtDescription("Durable context files stored for future turns.", checkedAt), body)}</div>`;
	}
	const body = `${tableControls("/admin/memory", memory, {
		comboboxes: [
			{
				name: "scope",
				label: "Scope",
				allLabel: "All scopes",
				options: memory.facets?.scopes ?? [],
			},
		],
	})}${table(
		["Scope", "Content", "Size", "Updated", "Hash", ""],
		memory.entries.map((entry, index) => [
			mono(entry.scopePath),
			truncatedText(memoryPreview(entry)),
			muted(`${entry.size} bytes`),
			mutedHtml(relativeTimeHtml(entry.mtimeMs)),
			mono(entry.sha256.slice(0, 12)),
			memoryDetails(entry, index),
		]),
		emptyStateForFilters(memory.filters, {
			title: "No memory files",
			message: "Once the agent starts saving memory, durable context files will show up here.",
		}),
	)}${pagination("/admin/memory", {
		rows: memory.entries,
		limit: memory.limit,
		offset: memory.offset,
		hasNext: memory.hasNext,
		filters: memory.filters,
	})}`;
	return `<div class="grid min-w-0 gap-4">${card("Memory", checkedAtDescription("Durable context files stored for future turns.", checkedAt), body)}</div>`;
}

function topNav(
	active: string,
	live: AdminOverview["live"],
	memoryFiles: number,
	csrf: string,
	auth?: boolean,
): string {
	const items = [
		{ label: "Chats", href: "/admin", key: "chats" },
		{
			label: "Approvals",
			href: "/admin/approvals",
			key: "approvals",
			count: live.pendingApprovals,
			field: "pendingApprovals",
		},
		{
			label: "Jobs",
			href: "/admin/jobs",
			key: "jobs",
			count: live.jobs,
			field: "jobs",
		},
		{
			label: "Evals",
			href: "/admin/evals",
			key: "evals",
		},
		{
			label: "Memory",
			href: "/admin/memory",
			key: "memory",
			count: memoryFiles,
		},
		{
			label: "Configuration",
			href: "/admin/configuration",
			key: "configuration",
		},
	];
	const desktop = `<div data-admin-nav-desktop class="flex min-w-0 flex-wrap items-center justify-end gap-1">${items
		.map((item) => navLink(item, active))
		.join("")}${navSeparator()}${docsLink()}${auth === false ? "" : logoutForm(csrf)}${themeToggle()}</div>`;
	return `<nav class="flex min-w-0 items-center justify-end gap-1 text-sm">${desktop}${mobileNavMenu(items, active, csrf, auth)}</nav>`;
}

function navLink(
	item: {
		label: string;
		href: string;
		key: string;
		count?: number;
		field?: string;
	},
	active: string,
): string {
	const selected = active === item.key;
	const count =
		item.count === undefined
			? ""
			: `<span class="badge-secondary"${item.field ? ` data-live-field="${escapeHtml(item.field)}"` : ""}>${item.count}</span>`;
	const className = [
		"btn-sm-ghost hover:text-foreground",
		selected ? "bg-muted text-foreground" : "text-muted-foreground",
		item.count === undefined ? "" : "pr-2",
	]
		.filter(Boolean)
		.join(" ");
	const current = selected ? ' aria-current="page"' : "";
	return `<a class="${className}" href="${item.href}" data-admin-nav-link="${escapeHtml(item.key)}"${current}>${escapeHtml(item.label)}${count}</a>`;
}

function navSeparator(): string {
	return `<span class="mx-1 h-4 w-px bg-border" aria-hidden="true" data-admin-nav-separator></span>`;
}

function mobileNavMenu(
	items: Array<{
		label: string;
		href: string;
		key: string;
		count?: number;
		field?: string;
	}>,
	active: string,
	csrf: string,
	auth?: boolean,
): string {
	return `<div id="admin-mobile-menu" data-admin-nav-mobile class="dropdown-menu">
		<button type="button" id="admin-mobile-menu-trigger" aria-haspopup="menu" aria-controls="admin-mobile-menu-menu" aria-expanded="false" class="btn-sm-icon-ghost text-muted-foreground hover:text-foreground" aria-label="Open menu" data-admin-mobile-menu-trigger data-tooltip="Menu" data-side="bottom" data-align="end">${icon("menu")}</button>
		<div id="admin-mobile-menu-popover" data-popover aria-hidden="true" data-align="end" class="min-w-56" data-admin-mobile-menu-popover>
		<div role="menu" id="admin-mobile-menu-menu" aria-labelledby="admin-mobile-menu-trigger">
			${items.map((item) => mobileNavItem(item, active)).join("")}
			<hr role="separator">
			${mobileDocsItem()}
			${mobileThemeItem()}
			${auth === false ? "" : mobileLogoutForm(csrf)}
		</div>
	</div>
</div>`;
}

function mobileNavItem(
	item: {
		label: string;
		href: string;
		key: string;
		count?: number;
		field?: string;
	},
	active: string,
): string {
	const selected = active === item.key;
	const count =
		item.count === undefined
			? ""
			: `<span class="badge-secondary ml-auto"${item.field ? ` data-live-field="${escapeHtml(item.field)}"` : ""}>${item.count}</span>`;
	const current = selected ? ' aria-current="page"' : "";
	return `<a role="menuitem" href="${item.href}" data-admin-mobile-nav-link="${escapeHtml(item.key)}"${current}${selected ? ' class="bg-muted text-foreground"' : ""}>${escapeHtml(item.label)}${count}</a>`;
}

function mobileDocsItem(): string {
	return `<a role="menuitem" href="${ADMIN_DOCS_HREF}" target="_blank" rel="noopener noreferrer" data-admin-mobile-docs-link>${icon("book-text")}Docs</a>`;
}

function mobileThemeItem(): string {
	return `<button type="button" role="menuitem" data-admin-theme-toggle class="w-full">
		<span class="block dark:hidden" data-admin-theme-icon="moon">${icon("moon")}</span>
		<span class="hidden dark:block" data-admin-theme-icon="sun">${icon("sun")}</span>
		Toggle theme
		</button>`;
}

function mobileLogoutForm(csrf: string): string {
	return `<form method="post" action="/admin/logout" class="contents">
		<input type="hidden" name="csrf" value="${escapeHtml(csrf)}">
		<button type="submit" role="menuitem" class="w-full" data-admin-mobile-logout>${icon("log-out")}Log out</button>
		</form>`;
}

function threadHeader(row: AdminThreadRow): string {
	return `<div class="flex min-w-0 items-center gap-2" data-admin-thread-header><span class="inline-flex shrink-0 items-center" data-tooltip="${escapeHtml(row.provider)}" data-side="bottom">${adapterIcon(row.provider)}</span><h2 class="min-w-0 truncate font-mono text-[13px]" data-admin-thread-channel>${escapeHtml(row.channel)}</h2><span class="min-w-0 truncate font-mono text-[13px] text-muted-foreground" data-admin-thread-id>${escapeHtml(row.id)}</span></div>`;
}

function threadList(page: AdminPage<AdminThreadRow>, selectedId?: string): string {
	const empty = emptyStateForFilters(page.filters, {
		title: "No threads yet",
		message: "Once the agent receives a message, the thread will show up here.",
	});
	if (!page.rows.length) {
		return emptyState({ ...empty, frame: "section", variant: "plain" });
	}
	return `<div class="grid min-w-0 gap-3" data-admin-thread-groups>${threadGroups(page.rows)
		.map((group) => threadGroup(group, selectedId))
		.join("")}</div>${pagination("/admin", page)}`;
}

function threadGroups(rows: AdminThreadRow[]): Array<{ key: string; label: string; rows: AdminThreadRow[] }> {
	const groups = new Map<string, { key: string; label: string; rows: AdminThreadRow[] }>();
	for (const row of rows) {
		const key = row.provider;
		let group = groups.get(key);
		if (!group) {
			group = { key, label: adapterLabel(row.provider), rows: [] };
			groups.set(key, group);
		}
		group.rows.push(row);
	}
	return [...groups.values()];
}

function threadGroup(
	group: { key: string; label: string; rows: AdminThreadRow[] },
	selectedId?: string,
): string {
	return `<section class="grid min-w-0 gap-1" data-admin-thread-group="${escapeHtml(group.key)}">
		<header class="flex min-w-0 items-center gap-2 px-3 text-xs font-medium uppercase tracking-normal text-muted-foreground" data-admin-thread-group-header>
			<span class="inline-flex shrink-0 items-center" aria-hidden="true">${adapterIcon(group.key)}</span>
			<span class="min-w-0 truncate">${escapeHtml(group.label)}</span>
			<span class="ml-auto font-mono">${group.rows.length}</span>
		</header>
		<div class="grid min-w-0 gap-1">${group.rows.map((row) => threadListItem(row, row.id === selectedId)).join("")}</div>
	</section>`;
}

function threadListItem(row: AdminThreadRow, selected: boolean): string {
	const current = selected ? ' aria-current="true"' : "";
	return `<a class="grid min-w-0 gap-1 rounded-sm p-3 text-sm hover:bg-muted/60 ${selected ? "bg-muted" : ""}" href="${escapeHtml(threadHref(row))}" data-admin-thread-item data-thread-id="${escapeHtml(row.id)}"${current}>
		<div class="flex min-w-0 items-center gap-2">
			<span class="inline-flex shrink-0 items-center" data-tooltip="${escapeHtml(row.provider)}" data-side="right">${adapterIcon(row.provider)}</span>
			<span class="shrink-0 font-mono text-[13px]" data-admin-thread-channel>${escapeHtml(row.channel)}</span>
			<span class="text-muted-foreground" aria-hidden="true">·</span>
			<span class="min-w-0 truncate text-muted-foreground" data-admin-thread-preview>${escapeHtml(threadPreview(row))}</span>
		</div>
		<div class="pl-6 text-xs text-muted-foreground" data-admin-thread-updated>
			${relativeTimeHtml(row.lastActivityAt)}
		</div>
	</a>`;
}

function threadConversationPanel(input?: AdminThreadView, csrf?: string): string {
	if (!input) {
		return `<div class="grid h-full place-items-center p-4" data-admin-thread-empty>${emptyState({
			title: "Select a thread",
			message: "Open a thread or send a local message.",
			actionHtml: adminComposeForm({ csrf }),
			variant: "plain",
		})}</div>`;
	}
	return `<div class="grid h-full min-h-0 grid-rows-[minmax(0,1fr)_auto]">
	<div class="scrollbar min-h-0 min-w-0 overflow-x-hidden overflow-y-auto px-4" data-admin-thread-scroll>
		<header class="sticky top-0 z-10 min-w-0 border-b bg-card pt-4 pb-3 text-sm" data-admin-thread-sticky-header>${threadHeader(input.thread)}</header>
	<div class="min-w-0 pb-4">${threadConversation(input, csrf)}</div>
	</div>
	${adminComposeForm({ csrf, threadId: input.thread.id })}
</div>`;
}

function adminComposeForm(input: { csrf?: string; threadId?: string; compact?: boolean } = {}): string {
	const compact = input.compact === true;
	const textareaClass = compact ? "min-h-0 h-16" : "min-h-24";
	return `<form class="grid min-w-0 gap-2 ${compact ? "border-t pt-3" : "w-full"}" method="post" action="/admin/messages" data-admin-compose>
	<input type="hidden" name="csrf" value="${escapeHtml(input.csrf ?? "")}">
	${input.threadId ? `<input type="hidden" name="threadId" value="${escapeHtml(input.threadId)}">` : ""}
	<label class="sr-only" for="${input.threadId ? "admin-compose-thread" : compact ? "admin-compose-sidebar" : "admin-compose-new"}">Message</label>
	<textarea id="${input.threadId ? "admin-compose-thread" : compact ? "admin-compose-sidebar" : "admin-compose-new"}" class="textarea ${textareaClass} resize-none text-sm" name="text" placeholder="Message..." required data-admin-compose-text></textarea>
	<div class="flex min-w-0 items-center justify-end gap-2">
		<button class="btn-sm-icon" type="submit" aria-label="Send message" data-admin-compose-submit data-tooltip="Send" data-side="top" data-align="end">${icon("send")}</button>
	</div>
</form>`;
}

function threadConversation(input: AdminThreadView, csrf?: string): string {
	const rows = input.timeline.filter(chatRowVisible).sort(chronologicalActivitySort);
	const selectedKey = input.event ?? (input.selected ? activityEvent(input.selected) : undefined);
	if (!rows.length) {
		return emptyState({
			title: "No messages yet",
			message: "Messages, approvals, and tool calls for this thread will show up here.",
			frame: "section",
			variant: "plain",
		});
	}
	return `<div class="grid min-w-0 gap-3 py-3">${rows
		.map((row) => chatRow(row, selectedKey === activityEvent(row), csrf))
		.join("")}</div>`;
}

function chatRow(row: AdminActivityRow, selected: boolean, csrf?: string): string {
	if (row.kind === "message") return chatMessageRow(row, selected);
	return chatContextRow(row, selected, csrf);
}

function chatMessageRow(row: AdminActivityRow, selected: boolean): string {
	const textDetail = activityDetail(row, "Text");
	const empty = !textDetail && row.title === "Empty message";
	const text = textDetail?.value ?? row.title;
	const user = row.role === "user";
	const state = row.state === "done" ? "" : `<span class="shrink-0">${cellHtml(statusBadge(row.state))}</span>`;
	const body = empty ? `<p class="italic text-muted-foreground">Empty message</p>` : markdownText(text);
	const author = user ? `${escapeHtml(messageAuthor(row))} <span aria-hidden="true">·</span> ` : "";
	const meta = `<footer class="text-xs text-muted-foreground">${author}${relativeTimeHtml(row.time, user ? "end" : undefined)}${state}</footer>`;
	if (user) {
		return `<article id="${escapeHtml(eventDomId(row))}" data-admin-message-role="user"${selectedAttr(selected)} class="grid min-w-0 justify-items-end px-2">
		<div class="grid max-w-[min(42rem,80%)] min-w-0 gap-2 rounded-lg bg-muted px-4 py-3">
			<div class="grid min-w-0 gap-2 text-sm leading-6">${body}</div>
			<div class="text-right">${meta}</div>
		</div>
	</article>`;
	}
	return `<article id="${escapeHtml(eventDomId(row))}" data-admin-message-role="assistant"${selectedAttr(selected)} class="grid min-w-0 justify-items-start px-2">
		<div class="grid max-w-[min(42rem,80%)] min-w-0 gap-2 rounded-lg bg-cyan-500/15 px-4 py-3 dark:bg-cyan-950">
		<div class="grid min-w-0 gap-2 text-sm leading-6">${body}</div>
		${meta}
	</div>
</article>`;
}

function chatContextRow(row: AdminActivityRow, selected: boolean, csrf?: string): string {
	const details = chatContextDetails(row, csrf);
	return `<details id="${escapeHtml(eventDomId(row))}" data-admin-context-row="${row.kind}"${selectedAttr(selected)} class="group rounded-sm px-2 py-2 text-sm hover:bg-muted/40">
		<summary class="flex min-w-0 items-center gap-2" data-admin-context-summary>
		${cellHtml(kindBadge(row.kind))}
		${cellHtml(statusBadge(row.state))}
		<span class="min-w-0 truncate font-medium">${escapeHtml(row.title)}</span>
		<span class="ml-auto shrink-0 text-xs text-muted-foreground">${relativeTimeHtml(row.time)}</span>
		${icon("chevron-right", "text-muted-foreground transition group-open:rotate-90")}
	</summary>
	${details}
</details>`;
}

function chatContextDetails(row: AdminActivityRow, csrf?: string): string {
	const detailLabels =
		row.kind === "event"
			? ["Trace", "Sequence", "Turn", "Call", "Approval", "Job run", "Data"]
			: ["Runtime", "Policy", "Expires", "Resolved by"];
	const details = compactActivityDetails([
		row.summary && row.summary !== row.title ? { label: "Detail", value: row.summary } : undefined,
		row.durationMs ? { label: "Duration", value: duration(row.durationMs) } : undefined,
		...(row.details ?? []).filter((detail) => detailLabels.includes(detail.label)),
	]);
	const actions = chatContextActions(row, csrf);
	if (!details.length && !actions) return "";
	const detailRows = details
		.map(
			(detail) =>
				`<div class="grid min-w-0 grid-cols-[5rem_minmax(0,1fr)] gap-3"><span class="text-muted-foreground">${escapeHtml(detail.label)}</span><span class="min-w-0 break-words [overflow-wrap:anywhere] text-foreground">${escapeHtml(detail.value)}</span></div>`,
		)
		.join("");
	return `<div class="mt-2 ml-3 grid min-w-0 gap-2 border-l pl-3 text-sm" data-admin-context-details>${actions}${detailRows}</div>`;
}

function chatContextActions(row: AdminActivityRow, csrf?: string): string {
	if (!csrf || !row.threadId) return "";
	if (row.kind === "run" && row.state === "running") {
		return threadActionForm({
			csrf,
			threadId: row.threadId,
			action: "cancel",
			id: row.id,
			label: "Cancel run",
			icon: "x",
		});
	}
	if (row.kind === "call") {
		return threadActionForm({
			csrf,
			threadId: row.threadId,
			action: "status",
			id: row.id,
			label: "Show call status",
			icon: "activity",
		});
	}
	return "";
}

function threadActionForm(input: {
	csrf: string;
	threadId: string;
	action: "cancel" | "status";
	id: string;
	label: string;
	icon: string;
}): string {
	return `<form method="post" action="/admin/thread-actions" class="flex min-w-max items-center gap-1.5" data-admin-thread-action="${escapeHtml(input.action)}">
	<input type="hidden" name="csrf" value="${escapeHtml(input.csrf)}">
	<input type="hidden" name="threadId" value="${escapeHtml(input.threadId)}">
	<input type="hidden" name="action" value="${escapeHtml(input.action)}">
	<input type="hidden" name="id" value="${escapeHtml(input.id)}">
	<label class="sr-only" for="thread-action-actor-${escapeHtml(input.action)}-${escapeHtml(input.id)}">Action actor</label>
	<input id="thread-action-actor-${escapeHtml(input.action)}-${escapeHtml(input.id)}" class="input h-8 w-[9rem] text-sm" name="actor" value="admin" aria-label="Action actor">
	<button class="btn-sm-icon-ghost text-muted-foreground hover:text-foreground" type="submit" aria-label="${escapeHtml(input.label)}" data-tooltip="${escapeHtml(input.label)}" data-side="top">${icon(input.icon)}</button>
</form>`;
}

function compactActivityDetails(input: Array<AdminActivityDetail | undefined>): AdminActivityDetail[] {
	return input.filter((row): row is AdminActivityDetail => Boolean(row?.value));
}

function chatRowVisible(row: AdminActivityRow): boolean {
	return row.kind !== "run" || row.state !== "done";
}

function chronologicalActivitySort(left: AdminActivityRow, right: AdminActivityRow): number {
	return left.time - right.time || left.kind.localeCompare(right.kind) || left.id.localeCompare(right.id);
}

function threadPreview(row: AdminThreadRow): string {
	const value = row.summary.replace(/^(?:Approval|Message|Run|Tool call):\s*/u, "");
	return plainPreview(value) || "No activity yet";
}

function plainPreview(input: string): string {
	return input
		.replace(/`([^`]*)`/gu, "$1")
		.replace(/\*\*([^*]+)\*\*/gu, "$1")
		.replace(/\*([^*]+)\*/gu, "$1")
		.replace(/^\s*[-*]\s+/gmu, "")
		.replace(/\s+/gu, " ")
		.trim();
}

function messageAuthor(row: AdminActivityRow): string {
	if (row.actor) return row.actor;
	if (row.role === "assistant") return "Assistant";
	if (row.role === "user") return "User";
	if (row.role === "tool") return "Tool";
	return roleLabel(row.role ?? "Message");
}

function markdownText(input: string): string {
	const lines = input.replace(/\r\n?/gu, "\n").split("\n");
	const blocks: string[] = [];
	let index = 0;
	while (index < lines.length) {
		if (!lines[index]?.trim()) {
			index += 1;
			continue;
		}
		const listItems: string[] = [];
		while (index < lines.length) {
			const match = /^\s*[-*]\s+(.+)$/u.exec(lines[index] ?? "");
			if (!match) break;
			listItems.push(`<li>${inlineMarkdown(match[1] ?? "")}</li>`);
			index += 1;
		}
		if (listItems.length) {
			blocks.push(`<ul class="list-disc pl-5">${listItems.join("")}</ul>`);
			continue;
		}
		const paragraph: string[] = [];
		while (index < lines.length && lines[index]?.trim() && !/^\s*[-*]\s+/u.test(lines[index] ?? "")) {
			paragraph.push(lines[index] ?? "");
			index += 1;
		}
		blocks.push(
			`<p class="whitespace-pre-wrap break-words [overflow-wrap:anywhere]">${inlineMarkdown(paragraph.join("\n"))}</p>`,
		);
	}
	return blocks.join("");
}

function inlineMarkdown(input: string): string {
	const parts = input.split(/(`[^`]*`)/u);
	return parts
		.map((part) => {
			if (part.startsWith("`") && part.endsWith("`")) {
				return escapeHtml(part.slice(1, -1));
			}
			return escapeHtml(part)
				.replace(/\*\*([^*]+)\*\*/gu, "<strong>$1</strong>")
				.replace(/\*([^*]+)\*/gu, "<em>$1</em>");
		})
		.join("");
}

function eventDomId(row: AdminActivityRow): string {
	return `event-${row.kind}-${row.id.replace(/[^a-zA-Z0-9_-]/gu, "-")}`;
}

function selectedAttr(selected: boolean): string {
	return selected ? ' data-selected-event="true"' : "";
}

function threadHref(row: AdminThreadRow): string {
	const params = new URLSearchParams();
	if (row.latestEvent) params.set("event", row.latestEvent);
	const query = params.toString();
	return `/admin/threads/${encodeURIComponent(row.id)}${query ? `?${query}` : ""}`;
}

function summaryList(rows: Array<[string, Cell]>, className = "", truncateValues = false): string {
	return `<div class="grid gap-2.5 ${escapeHtml(className)}">${rows
		.map(
			([label, value]) =>
				`<div class="grid grid-cols-[minmax(5.5rem,7.5rem)_minmax(0,1fr)] items-start gap-3 max-[760px]:grid-cols-1 max-[760px]:gap-0.5"><div class="leading-6 text-muted-foreground">${escapeHtml(label)}</div><div class="min-w-0 ${truncateValues ? "truncate" : "break-words [overflow-wrap:anywhere]"} leading-6">${cellHtml(value)}</div></div>`,
		)
		.join("")}</div>`;
}

function dialogList(rows: Array<[string, Cell]>): string {
	return `<div class="grid w-full min-w-0 gap-2.5">${rows
		.map(
			([label, value]) =>
				`<div class="grid min-w-0 grid-cols-[8rem_minmax(0,1fr)] items-start gap-3 max-[760px]:grid-cols-1 max-[760px]:gap-0.5"><div class="leading-6 text-muted-foreground">${escapeHtml(label)}</div><div class="min-w-0 max-w-full whitespace-normal break-words [overflow-wrap:anywhere] [word-break:break-word] leading-6">${cellHtml(value)}</div></div>`,
		)
		.join("")}</div>`;
}

function checkedAtDescription(text: string, checkedAt?: number): Cell {
	return html(
		`${escapeHtml(text)} <span class="whitespace-nowrap" data-live-field="checkedAt">${escapeHtml(lastUpdatedText(checkedAt))}</span>`,
	);
}

function lastUpdatedText(checkedAt?: number): string {
	return checkedAt
		? `Last updated ${new Date(checkedAt).toLocaleTimeString()}`
		: "Last updated after live summary connects.";
}

function card(title: string, description: CardDescription, body: string): string {
	return `<div class="card min-w-0 overflow-hidden"><header class="min-w-0"><h2>${escapeHtml(title)}</h2>${description ? `<p>${cellHtml(description)}</p>` : ""}</header><section class="min-w-0">${body}</section></div>`;
}

type FilterName = keyof AdminPageFilters;

type SelectFilter = {
	name: Extract<FilterName, "type" | "state">;
	label: string;
	allLabel: string;
	options: Array<[string, string]>;
};

type ComboboxFilter = {
	name: Extract<FilterName, "channel" | "actor" | "scope">;
	label: string;
	allLabel: string;
	options: string[];
};

function tableControls(
	path: string,
	page: {
		limit: number;
		truncated?: boolean;
		filters?: AdminPageFilters;
		facets?: AdminFilterFacets;
	},
	input: { selects?: SelectFilter[]; comboboxes?: ComboboxFilter[] } = {},
): string {
	const filters = page.filters ?? {};
	const hasFilters = activeFilters(filters);
	return `<form class="mb-4 flex w-full flex-nowrap items-center gap-2 overflow-x-visible pb-1 whitespace-nowrap max-[760px]:overflow-x-auto" method="get" action="${escapeHtml(path)}" data-admin-filter-form>
		<input type="hidden" name="limit" value="${page.limit}">
		<div class="relative h-8 w-[14rem] shrink-0">
		<input type="text" name="q" class="input h-8 pl-8 text-sm" placeholder="Search..." value="${escapeHtml(filters.q ?? "")}" aria-label="Search" data-admin-filter-search>
	<div class="absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none text-muted-foreground [&>svg]:size-4">
	${icon("search")}
	</div>
	</div>
	${(input.selects ?? []).map((filter) => selectFilter(filter, filters)).join("")}
	${(input.comboboxes ?? []).map((filter) => comboboxFilter(filter, filters)).join("")}
			<button class="btn-sm shrink-0" type="submit" data-admin-filter-submit>Filter</button>
			${hasFilters ? `<a class="btn-sm-ghost shrink-0" href="${escapeHtml(path)}" data-admin-filter-reset>Reset</a>` : ""}
	</form>${scanNotice(page)}`;
}

function scanNotice(page: { truncated?: boolean }): string {
	if (!page.truncated) return "";
	return `<div class="mb-4 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-950 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-100">Filtered results may be incomplete. Narrow the filters to scan a smaller set.</div>`;
}

function selectFilter(input: SelectFilter, filters: AdminPageFilters): string {
	const value = filters[input.name] ?? "";
	return `<select class="select h-8 w-[9rem] shrink-0 py-1 text-sm" name="${input.name}" aria-label="${escapeHtml(input.label)}" data-admin-filter-select="${input.name}">
	<option value="">${escapeHtml(input.allLabel)}</option>
	${input.options
		.map(
			([optionValue, label]) =>
				`<option value="${escapeHtml(optionValue)}"${optionValue === value ? " selected" : ""}>${escapeHtml(label)}</option>`,
		)
		.join("")}
	</select>`;
}

function comboboxFilter(input: ComboboxFilter, filters: AdminPageFilters): string {
	const value = filters[input.name] ?? "";
	const options = filterOptions(input.options, value);
	const id = `filter-${input.name}`;
	const label = value || input.allLabel;
	return `<div id="${id}" class="select h-8 w-[11rem] shrink-0" data-admin-filter-combobox="${input.name}">
	<button type="button" class="btn-sm-outline h-8 w-full" id="${id}-trigger" aria-haspopup="listbox" aria-expanded="false" aria-controls="${id}-listbox" aria-label="${escapeHtml(input.label)}">
	<span class="truncate">${escapeHtml(label)}</span>
	${icon("chevrons-up-down", "text-muted-foreground opacity-50 shrink-0")}
	</button>
	<div id="${id}-popover" data-popover aria-hidden="true">
	<header>
	${icon("search")}
	<input type="text" value="" placeholder="Search ${escapeHtml(input.label.toLowerCase())}..." autocomplete="off" autocorrect="off" spellcheck="false" aria-autocomplete="list" role="combobox" aria-expanded="false" aria-controls="${id}-listbox" aria-labelledby="${id}-trigger">
	</header>
	<div role="listbox" id="${id}-listbox" aria-orientation="vertical" aria-labelledby="${id}-trigger" data-empty="No ${escapeHtml(input.label.toLowerCase())} found.">
	<div id="${id}-all" role="option" data-value=""${value ? "" : ' aria-selected="true"'}>${escapeHtml(input.allLabel)}</div>
	${options
		.map(
			(option, index) =>
				`<div id="${id}-option-${index}" role="option" data-value="${escapeHtml(option)}"${option === value ? ' aria-selected="true"' : ""}>${escapeHtml(option)}</div>`,
		)
		.join("")}
	</div>
	</div>
	<input type="hidden" name="${input.name}" value="${escapeHtml(value)}">
	</div>`;
}

function filterOptions(options: string[], value: string): string[] {
	const out = new Set(options);
	if (value) out.add(value);
	return [...out].sort((left, right) => left.localeCompare(right));
}

function activeFilters(filters: AdminPageFilters | undefined): boolean {
	return Boolean(filters && Object.values(filters).some(Boolean));
}

function emptyStateForFilters(
	filters: AdminPageFilters | undefined,
	fallback: { title: string; message: string },
): { title: string; message: string } {
	if (!activeFilters(filters)) return fallback;
	return {
		title: "No matching results",
		message: "Adjust the search or filters to show more rows.",
	};
}

function table(headers: string[], rows: Cell[][], emptyInput?: { title: string; message: string }): string {
	if (!rows.length)
		return emptyState({
			title: emptyInput?.title ?? "No rows",
			message: emptyInput?.message ?? "There is nothing to show for this view yet.",
			frame: "section",
			variant: "outline",
		});
	return `<div class="w-full max-w-full overflow-x-auto rounded-lg border" data-admin-table-wrap><table class="table min-w-max border-0" data-admin-table><thead><tr>${headers
		.map(
			(header, index) =>
				`<th${edgeClass(index, headers.length)} data-admin-column="${escapeHtml(header)}">${escapeHtml(header)}</th>`,
		)
		.join("")}</tr></thead><tbody>${rows
		.map(
			(row) =>
				`<tr>${row.map((cell, index) => `<td${edgeClass(index, row.length)}>${cellHtml(cell)}</td>`).join("")}</tr>`,
		)
		.join("")}</tbody></table></div>`;
}

function edgeClass(index: number, length: number): string {
	const classes = [index === 0 ? "pl-4" : "", index === length - 1 ? "pr-4" : ""].filter(Boolean);
	return classes.length ? ` class="${classes.join(" ")}"` : "";
}

function cellHtml(cell: Cell): string {
	return typeof cell === "string" ? escapeHtml(cell) : cell.html;
}

function pagination<T>(path: string, page: AdminPage<T>): string {
	if (page.offset === 0 && !page.hasNext) return "";
	const prevOffset = Math.max(page.offset - page.limit, 0);
	const nextOffset = page.offset + page.limit;
	const prevDisabled = page.offset === 0;
	const nextDisabled = !page.hasNext;
	return `<nav role="navigation" aria-label="pagination" class="mt-4 flex w-full justify-end">
	<ul class="flex flex-row items-center gap-1">
	<li>${pageLink("Previous", path, page.limit, prevOffset, prevDisabled, "left", page.filters)}</li>
	<li>${pageLink("Next", path, page.limit, nextOffset, nextDisabled, "right", page.filters)}</li>
	</ul>
	</nav>`;
}

function pageLink(
	label: string,
	path: string,
	limit: number,
	offset: number,
	disabled: boolean,
	direction: "left" | "right",
	filters?: AdminPageFilters,
): string {
	const left = direction === "left" ? icon("chevron-left") : "";
	const right = direction === "right" ? icon("chevron-right") : "";
	const content = `${left}${escapeHtml(label)}${right}`;
	if (disabled) return `<span class="btn-sm-ghost opacity-50" aria-disabled="true">${content}</span>`;
	return `<a class="btn-sm-ghost" href="${escapeHtml(pageHref(path, limit, offset, filters))}">${content}</a>`;
}

function pageHref(path: string, limit: number, offset: number, filters?: AdminPageFilters): string {
	const params = new URLSearchParams({
		limit: String(limit),
		offset: String(offset),
	});
	for (const key of ["q", "provider", "type", "state", "channel", "actor", "scope"] as const) {
		const value = filters?.[key];
		if (value) params.set(key, value);
	}
	return `${path}?${params.toString()}`;
}

function emptyState(input: {
	title: string;
	message: string;
	actionHref?: string;
	actionLabel?: string;
	actionHtml?: string;
	frame?: "inline" | "page" | "section";
	variant?: "outline" | "plain";
}): string {
	const border = input.variant === "outline" ? " border-dashed border" : "";
	const actionHtml =
		input.actionHtml ??
		(input.actionHref
			? `<div class="flex gap-2"><a class="btn-sm-outline inline-flex items-center gap-1.5" href="${escapeHtml(input.actionHref)}"${externalAttrs(input.actionHref)}>${escapeHtml(input.actionLabel ?? "Learn more")}${icon("arrow-up-right", "opacity-50")}</a></div>`
			: "");
	const frame = input.frame === "page" ? " min-h-[calc(100vh-2rem)]" : "";
	return `<div class="flex w-full min-w-0 flex-col items-center justify-center gap-6 rounded-lg${border}${frame} p-6 text-center text-balance text-neutral-800 md:p-12 dark:text-neutral-300" data-admin-empty-state>
	<header class="flex max-w-sm flex-col items-center gap-2 text-center">
	<h3 class="font-medium tracking-tight" data-admin-empty-title>${escapeHtml(input.title)}</h3>
	<p class="text-muted-foreground [&>a:hover]:text-primary text-sm/relaxed [&>a]:underline [&>a]:underline-offset-4" data-admin-empty-message>${escapeHtml(input.message)}</p>
</header>
${actionHtml ? `<section class="flex w-full max-w-sm min-w-0 flex-col items-center gap-4 text-sm text-balance">${actionHtml}</section>` : ""}
</div>`;
}

function themeToggle(): string {
	return `<button type="button" aria-label="Toggle theme" data-admin-theme-toggle class="btn-sm-icon-ghost text-muted-foreground hover:text-foreground" data-tooltip="Toggle theme" data-side="bottom" data-align="end">
		<span class="block dark:hidden" data-admin-theme-icon="moon">${icon("moon")}</span>
		<span class="hidden dark:block" data-admin-theme-icon="sun">${icon("sun")}</span>
		</button>`;
}

function docsLink(): string {
	return `<a class="btn-sm-icon-ghost text-muted-foreground hover:text-foreground" href="${ADMIN_DOCS_HREF}" target="_blank" rel="noopener noreferrer" aria-label="Docs" data-admin-docs-link data-tooltip="Docs" data-side="bottom">${icon("book-text")}</a>`;
}

function kindBadge(kind: AdminActivityRow["kind"]): Cell {
	return badge(kindLabel(kind));
}

function statusBadge(state: string): Cell {
	return {
		html: `<span class="badge-secondary ${stateBg(state)}">${escapeHtml(stateLabel(state))}</span>`,
	};
}

function badge(input: string): Cell {
	return { html: `<span class="badge-secondary">${escapeHtml(input)}</span>` };
}

function html(input: string): Cell {
	return { html: input };
}

function muted(input: string): Cell {
	return {
		html: `<span class="text-muted-foreground">${escapeHtml(input)}</span>`,
	};
}

function mutedHtml(input: string): Cell {
	return { html: `<span class="text-muted-foreground">${input}</span>` };
}

function mono(input: string): Cell {
	return {
		html: `<span class="font-mono text-[13px] [overflow-wrap:anywhere]">${escapeHtml(input)}</span>`,
	};
}

function wrapText(input: string): Cell {
	return {
		html: `<span class="break-words [overflow-wrap:anywhere]">${escapeHtml(input)}</span>`,
	};
}

function copyable(label: string, value: string, display: Cell): Cell {
	return html(
		`<span class="flex min-w-0 items-start gap-2"><span class="min-w-0 flex-1">${cellHtml(display)}</span>${copyButton(label, value)}</span>`,
	);
}

function copyButton(label: string, value: string): string {
	return `<button type="button" class="btn-sm-icon-ghost size-6 shrink-0 text-muted-foreground hover:text-foreground" aria-label="Copy ${escapeHtml(label)}" data-admin-copy="${escapeHtml(value)}" data-admin-copy-label="${escapeHtml(label)}">${icon("copy")}</button>`;
}

function truncatedText(input: string): Cell {
	return {
		html: `<div class="max-w-[34rem] overflow-hidden text-ellipsis whitespace-nowrap text-muted-foreground max-[760px]:max-w-[18rem]">${escapeHtml(input)}</div>`,
	};
}

function stateBg(state: string): string {
	if (["active", "approved", "completed", "done", "succeeded", "success"].includes(state)) {
		return "bg-emerald-100 dark:bg-emerald-900";
	}
	if (["blocked", "pending", "pending_approval", "running"].includes(state)) {
		return "bg-amber-100 dark:bg-amber-900";
	}
	if (["cancelled", "denied", "expired", "failed", "rejected", "unauthorized"].includes(state)) {
		return "bg-red-100 dark:bg-red-900";
	}
	if (["idle", "paused", "skipped"].includes(state)) return "bg-zinc-100 dark:bg-zinc-900";
	return "bg-muted";
}

function adapterList(adapters: AdminOverview["adapters"]): Cell {
	if (!adapters.length) return mono("none");
	return html(
		`<span class="flex min-w-0 flex-wrap items-center gap-2">${adapters
			.map((adapter) => {
				const permission = adapterPermissionSummary(adapter.permissions);
				const title = [adapter.kind, permission].filter(Boolean).join(", ");
				return `<span class="inline-flex min-w-0 items-center gap-1.5" title="${escapeHtml(title)}">${adapterIcon(adapter.kind)}<span class="min-w-0 truncate font-mono text-[13px]">${escapeHtml(adapter.name)}</span>${permission ? `<span class="text-xs text-muted-foreground">${escapeHtml(permission)}</span>` : ""}</span>`;
			})
			.join("")}</span>`,
	);
}

function taskSummary(task: AdminOverview["task"]): string {
	return `Busy: ${task.busy}; cancel: ${task.cancel}`;
}

function approvalSummary(input: AdminOverview): string {
	const approval = input.approval;
	return [
		`expires: ${approval?.expiresInMs ? duration(approval.expiresInMs) : "default"}`,
		`self: ${approval?.allowSelfApproval === false ? "blocked" : "allowed"}`,
		approval?.bypass === false
			? "bypass: off"
			: approval?.bypass
				? `bypass: ${approval.bypass.scope ?? "thread"} for ${duration(approval.bypass.durationMs ?? 5 * 60_000)}`
				: "bypass: off",
	].join("; ");
}

function bypassList(rows: ApprovalBypass[]): Cell {
	if (!rows.length) return mono("none");
	return html(
		`<span class="grid min-w-0 gap-1">${rows
			.map(
				(row) =>
					`<span class="min-w-0 text-xs"><span class="font-mono">${escapeHtml(row.id)}</span> ${escapeHtml(row.scope)} actor ${escapeHtml(row.actor ?? "-")} target ${escapeHtml(bypassTarget(row))} by ${escapeHtml(row.createdBy)} <span class="text-muted-foreground">until ${escapeHtml(time(row.expiresAt))}</span></span>`,
			)
			.join("")}</span>`,
	);
}

function bypassTarget(row: ApprovalBypass): string {
	return row.threadId ? `${row.channel} / ${row.threadId}` : row.channel;
}

function adapterPermissionSummary(permissions: AdminOverview["adapters"][number]["permissions"]): string {
	const approvers = actorCount(permissions?.approvers);
	const admins = actorCount(permissions?.admins);
	return [
		approvers ? `${approvers} approver${approvers === 1 ? "" : "s"}` : undefined,
		admins ? `${admins} admin${admins === 1 ? "" : "s"}` : undefined,
	]
		.filter(Boolean)
		.join(", ");
}

function actorCount(policy: Parameters<typeof actorUsers>[0]): number {
	return actorUsers(policy).length + actorGroups(policy).length;
}

function memorySummary(memory: AdminMemory): string {
	if (!memory.enabled) return "Disabled";
	const scope = memory.scope === "agent" ? "shared by agent" : `shared by ${memory.scope}`;
	const writes =
		memory.writePolicy === "approvers"
			? "approver writes"
			: memory.writePolicy === "auto"
				? "auto writes"
				: "writes off";
	return `Enabled, ${scope}, ${writes}`;
}

function scheduleText(row: AdminJob): string {
	if (row.kind === "heartbeat") {
		return row.idleMs ? `idle ${duration(row.idleMs)}` : "heartbeat";
	}
	return row.schedule;
}

function activityDetail(row: AdminActivityRow, label: string): AdminActivityDetail | undefined {
	return row.details?.find((detail) => detail.label === label);
}

function evalDetails(row: AdminEval, index: number): Cell {
	const id = `eval-detail-${index}`;
	const detailRows: Array<[string, Cell]> = [
		["Name", copyable("eval name", row.name, mono(row.name))],
		["Tags", row.tags.length ? row.tags.join(", ") : "-"],
		["Timeout", row.timeoutMs ? duration(row.timeoutMs) : "-"],
		["Expectation", wrapPre(row.expectDetail)],
		["Prompt", copyable("prompt", row.prompt, wrapPre(row.prompt))],
	];
	return html(`<button type="button" class="btn-sm-ghost" data-admin-dialog-open="${id}" data-admin-eval-details="${escapeHtml(row.name)}">Details</button>
<dialog id="${id}" class="dialog w-[calc(100vw-2rem)] max-w-[1040px] max-h-[calc(100vh-2rem)] overflow-hidden" aria-labelledby="${id}-title" data-admin-dialog>
<div class="w-full min-w-0 overflow-hidden">
<header><h2 id="${id}-title">Eval details</h2></header>
<section class="min-w-0 overflow-y-auto overflow-x-hidden">${dialogList(detailRows)}</section>
<button type="button" aria-label="Close dialog" data-admin-dialog-close>${icon("x")}</button>
</div>
</dialog>`);
}

function memoryDetails(entry: AdminMemory["entries"][number], index: number): Cell {
	const id = `memory-detail-${index}`;
	const content = `${escapeHtml(entry.text)}${entry.truncated ? "\n..." : ""}`;
	const detailRows: Array<[string, Cell]> = [
		["Scope", copyable("scope", entry.scopePath, mono(entry.scopePath))],
		["Path", copyable("path", entry.path, wrapText(entry.path))],
		["Size", `${entry.size} bytes`],
		["Updated", time(entry.mtimeMs)],
		["SHA-256", copyable("SHA-256", entry.sha256, mono(entry.sha256))],
		[
			"Content",
			copyable(
				"content",
				entry.text,
				html(
					`<div class="max-w-full whitespace-pre-wrap break-words [overflow-wrap:anywhere]" data-admin-memory-content>${content}</div>`,
				),
			),
		],
	];
	return html(`<button type="button" class="btn-sm-ghost" data-admin-dialog-open="${id}">Details</button>
<dialog id="${id}" class="dialog w-[calc(100vw-2rem)] max-w-[1040px] max-h-[calc(100vh-2rem)] overflow-hidden" aria-labelledby="${id}-title" data-admin-dialog>
<div class="w-full min-w-0 overflow-hidden">
<header><h2 id="${id}-title">Memory details</h2></header>
<section class="min-w-0 overflow-y-auto overflow-x-hidden">${dialogList(detailRows)}</section>
<button type="button" aria-label="Close dialog" data-admin-dialog-close>${icon("x")}</button>
</div>
</dialog>`);
}

function memoryPreview(entry: AdminMemory["entries"][number]): string {
	const text = entry.text.trim().replace(/\s+/gu, " ");
	if (!text) return "-";
	return entry.truncated ? `${text} ...` : text;
}

function wrapPre(input: string): Cell {
	return html(`<div class="max-w-full whitespace-pre-wrap break-words [overflow-wrap:anywhere]">${escapeHtml(input)}</div>`);
}

function relativeTimeHtml(input: number, align?: "end"): string {
	const ago = duration(Math.max(Date.now() - input, 0));
	return `<span data-tooltip="${escapeHtml(time(input))}" data-side="top"${align ? ` data-align="${align}"` : ""}>${escapeHtml(`${ago} ago`)}</span>`;
}

function futureTimeHtml(input: number | null): string {
	if (!input) return "No expiry";
	const delta = input - Date.now();
	const label = delta >= 0 ? duration(delta) : "Expired";
	return `<span data-tooltip="${escapeHtml(time(input))}" data-side="top">${escapeHtml(label)}</span>`;
}

function timeHintHtml(input: number | null, empty: string): string {
	if (!input) return escapeHtml(empty);
	const delta = input - Date.now();
	const label = delta > 0 ? `in ${duration(delta)}` : `${duration(Math.abs(delta))} ago`;
	return `<span data-tooltip="${escapeHtml(time(input))}" data-side="top">${escapeHtml(label)}</span>`;
}

function kindLabel(kind: AdminActivityRow["kind"]): string {
	const labels: Record<AdminActivityRow["kind"], string> = {
		approval: "Approval",
		call: "Tool call",
		event: "Event",
		message: "Message",
		run: "Run",
	};
	return labels[kind];
}

function stateLabel(state: string): string {
	const labels: Record<string, string> = {
		active: "Active",
		approved: "Approved",
		blocked: "Waiting approval",
		cancelled: "Cancelled",
		denied: "Denied",
		done: "Done",
		failed: "Failed",
		idle: "Idle",
		paused: "Paused",
		pending: "Pending",
		pending_approval: "Needs approval",
		running: "Running",
		skipped: "Skipped",
		unauthorized: "Unauthorized",
	};
	return labels[state] ?? state;
}

function roleLabel(role: string): string {
	const labels: Record<string, string> = {
		assistant: "Assistant",
		system: "System",
		tool: "Tool",
		user: "User",
	};
	return labels[role] ?? role;
}

function docsAction(): string {
	return `<div class="flex gap-2"><a class="btn-sm-outline inline-flex items-center gap-1.5" href="${ADMIN_DOCS_HREF}" target="_blank" rel="noopener noreferrer">More about heypi${icon("arrow-up-right", "opacity-50")}</a></div>`;
}

function logo(className = "h-auto w-24"): string {
	return `<svg class="${escapeHtml(className)}" viewBox="0 0 816 192" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
		<path d="M48 192H0V0H48V48H144V192H96V96H48V192Z" fill="currentColor"/>
		<path fill-rule="evenodd" clip-rule="evenodd" d="M336 48L240 144H336V192H192V48L240 0H336V48ZM240 96L288 48H240V96Z" fill="currentColor"/>
		<path d="M432 96H480V0H528V192H480V144H384V0H432V96Z" fill="currentColor"/>
		<path fill-rule="evenodd" clip-rule="evenodd" d="M720 144H624V192H576V0H720V144ZM624 96H672V48H624V96Z" fill="currentColor"/>
		<path d="M816 192H768V144H816V192Z" fill="currentColor"/>
		<path d="M816 96H768V0H816V96Z" fill="currentColor"/>
	</svg>`;
}

function adapterIcon(kind: string): string {
	if (kind === "slack")
		return `<svg class="size-4 shrink-0" viewBox="0 0 2447.6 2452.5" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><g clip-rule="evenodd" fill-rule="evenodd"><path d="m897.4 0c-135.3.1-244.8 109.9-244.7 245.2-.1 135.3 109.5 245.1 244.8 245.2h244.8v-245.1c.1-135.3-109.5-245.1-244.9-245.3.1 0 .1 0 0 0m0 654h-652.6c-135.3.1-244.9 109.9-244.8 245.2-.2 135.3 109.4 245.1 244.7 245.3h652.7c135.3-.1 244.9-109.9 244.8-245.2.1-135.4-109.5-245.2-244.8-245.3z" fill="#36c5f0"/><path d="m2447.6 899.2c.1-135.3-109.5-245.1-244.8-245.2-135.3.1-244.9 109.9-244.8 245.2v245.3h244.8c135.3-.1 244.9-109.9 244.8-245.3zm-652.7 0v-654c.1-135.2-109.4-245-244.7-245.2-135.3.1-244.9 109.9-244.8 245.2v654c-.2 135.3 109.4 245.1 244.7 245.3 135.3-.1 244.9-109.9 244.8-245.3z" fill="#2eb67d"/><path d="m1550.1 2452.5c135.3-.1 244.9-109.9 244.8-245.2.1-135.3-109.5-245.1-244.8-245.2h-244.8v245.2c-.1 135.2 109.5 245 244.8 245.2zm0-654.1h652.7c135.3-.1 244.9-109.9 244.8-245.2.2-135.3-109.4-245.1-244.7-245.3h-652.7c-135.3.1-244.9 109.9-244.8 245.2-.1 135.4 109.4 245.2 244.7 245.3z" fill="#ecb22e"/><path d="m0 1553.2c-.1 135.3 109.5 245.1 244.8 245.2 135.3-.1 244.9-109.9 244.8-245.2v-245.2h-244.8c-135.3.1-244.9 109.9-244.8 245.2zm652.7 0v654c-.2 135.3 109.4 245.1 244.7 245.3 135.3-.1 244.9-109.9 244.8-245.2v-653.9c.2-135.3-109.4-245.1-244.7-245.3-135.4 0-244.9 109.8-244.8 245.1 0 0 0 .1 0 0" fill="#e01e5a"/></g></svg>`;
	if (kind === "discord")
		return `<svg class="size-4 shrink-0" viewBox="0 0 256 199" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path d="M216.856 16.597A208.502 208.502 0 0 0 164.042 0c-2.275 4.113-4.933 9.645-6.766 14.046-19.692-2.961-39.203-2.961-58.533 0-1.832-4.4-4.55-9.933-6.846-14.046a207.809 207.809 0 0 0-52.855 16.638C5.618 67.147-3.443 116.4 1.087 164.956c22.169 16.555 43.653 26.612 64.775 33.193A161.094 161.094 0 0 0 79.735 175.3a136.413 136.413 0 0 1-21.846-10.632 108.636 108.636 0 0 0 5.356-4.237c42.122 19.702 87.89 19.702 129.51 0a131.66 131.66 0 0 0 5.355 4.237 136.07 136.07 0 0 1-21.886 10.653c4.006 8.02 8.638 15.67 13.873 22.848 21.142-6.58 42.646-16.637 64.815-33.213 5.316-56.288-9.08-105.09-38.056-148.36ZM85.474 135.095c-12.645 0-23.015-11.805-23.015-26.18s10.149-26.2 23.015-26.2c12.867 0 23.236 11.804 23.015 26.2.02 14.375-10.148 26.18-23.015 26.18Zm85.051 0c-12.645 0-23.014-11.805-23.014-26.18s10.148-26.2 23.014-26.2c12.867 0 23.236 11.804 23.015 26.2 0 14.375-10.148 26.18-23.015 26.18Z" fill="#5865F2"/></svg>`;
	if (kind === "telegram")
		return `<svg class="size-4 shrink-0" viewBox="0 0 256 256" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path fill="#229ED9" d="M128 0C94.06 0 61.48 13.494 37.5 37.49A128.038 128.038 0 0 0 0 128c0 33.934 13.5 66.514 37.5 90.51C61.48 242.506 94.06 256 128 256s66.52-13.494 90.5-37.49c24-23.996 37.5-56.576 37.5-90.51 0-33.934-13.5-66.514-37.5-90.51C194.52 13.494 161.94 0 128 0Z"/><path fill="#FFF" d="M57.94 126.648c37.32-16.256 62.2-26.974 74.64-32.152 35.56-14.786 42.94-17.354 47.76-17.441 1.06-.017 3.42.245 4.96 1.49 1.28 1.05 1.64 2.47 1.82 3.467.16.996.38 3.266.2 5.038-1.92 20.24-10.26 69.356-14.5 92.026-1.78 9.592-5.32 12.808-8.74 13.122-7.44.684-13.08-4.912-20.28-9.63-11.26-7.386-17.62-11.982-28.56-19.188-12.64-8.328-4.44-12.906 2.76-20.386 1.88-1.958 34.64-31.748 35.26-34.45.08-.338.16-1.598-.6-2.262-.74-.666-1.84-.438-2.64-.258-1.14.256-19.12 12.152-54 35.686-5.1 3.508-9.72 5.218-13.88 5.128-4.56-.098-13.36-2.584-19.9-4.708-8-2.606-14.38-3.984-13.82-8.41.28-2.304 3.46-4.662 9.52-7.072Z"/></svg>`;
	return icon("webhook", "size-4 shrink-0 text-muted-foreground");
}

function adapterLabel(kind: string): string {
	if (kind === "slack") return "Slack";
	if (kind === "discord") return "Discord";
	if (kind === "telegram") return "Telegram";
	if (kind === "webhook") return "Webhook";
	if (kind === "local") return "Local";
	return kind;
}

function externalAttrs(href: string): string {
	return /^https?:\/\//u.test(href) ? ' target="_blank" rel="noopener noreferrer"' : "";
}

function time(input: number | null): string {
	return input ? new Date(input).toLocaleString() : "-";
}

function duration(ms: number): string {
	if (ms < 1000) return `${ms}ms`;
	const seconds = Math.floor(ms / 1000);
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
	const hours = Math.floor(minutes / 60);
	if (hours < 48) return `${hours}h ${minutes % 60}m`;
	const days = Math.floor(hours / 24);
	return `${days}d ${hours % 24}h`;
}

function icon(name: string, className?: string): string {
	const common = `xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"`;
	const paths: Record<string, string> = {
		activity: '<path d="M22 12h-4l-3 9L9 3l-3 9H2"/>',
		"arrow-up-right": '<path d="M7 7h10v10"/><path d="M7 17 17 7"/>',
		"book-text":
			'<path d="M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H19a1 1 0 0 1 1 1v18a1 1 0 0 1-1 1H6.5a1 1 0 0 1 0-5H20"/><path d="M8 11h8"/><path d="M8 7h6"/>',
		check: '<path d="M20 6 9 17l-5-5"/>',
		"chevron-left": '<path d="m15 18-6-6 6-6"/>',
		"chevron-right": '<path d="m9 18 6-6-6-6"/>',
		"chevrons-up-down": '<path d="m7 15 5 5 5-5"/><path d="m7 9 5-5 5 5"/>',
		circle: '<circle cx="12" cy="12" r="4"/>',
		clock: '<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>',
		copy: '<rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>',
		database:
			'<ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M3 5v14c0 1.7 4 3 9 3s9-1.3 9-3V5"/><path d="M3 12c0 1.7 4 3 9 3s9-1.3 9-3"/>',
		key: '<path d="m15.5 7.5 1 1"/><path d="m10 13 6.5-6.5a2.1 2.1 0 0 1 3 3L13 16"/><path d="M5 21h4l8.5-8.5"/><path d="M5 21v-4l8.5-8.5"/>',
		layout: '<rect width="18" height="18" x="3" y="3" rx="2"/><path d="M3 9h18"/><path d="M9 21V9"/>',
		"log-out":
			'<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" x2="9" y1="12" y2="12"/>',
		menu: '<path d="M4 5h16"/><path d="M4 12h16"/><path d="M4 19h16"/>',
		moon: '<path d="M20.985 12.486a9 9 0 1 1-9.473-9.472c.405-.022.617.46.402.803a6 6 0 0 0 8.268 8.268c.344-.215.825-.004.803.401"/>',
		minus: '<path d="M5 12h14"/>',
		pause: '<path d="M10 4v16"/><path d="M14 4v16"/>',
		refresh:
			'<path d="M21 12a9 9 0 0 0-9-9 9.8 9.8 0 0 0-6.7 2.7L3 8"/><path d="M3 3v5h5"/><path d="M3 12a9 9 0 0 0 9 9 9.8 9.8 0 0 0 6.7-2.7L21 16"/><path d="M16 16h5v5"/>',
		route: '<circle cx="6" cy="19" r="3"/><path d="M9 19h8.5a3.5 3.5 0 0 0 0-7h-11a3.5 3.5 0 0 1 0-7H15"/><circle cx="18" cy="5" r="3"/>',
		search: '<path d="m21 21-4.34-4.34"/><circle cx="11" cy="11" r="8"/>',
		send: '<path d="m22 2-7 20-4-9-9-4Z"/><path d="M22 2 11 13"/>',
		sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2"/><path d="M12 20v2"/><path d="m4.93 4.93 1.41 1.41"/><path d="m17.66 17.66 1.41 1.41"/><path d="M2 12h2"/><path d="M20 12h2"/><path d="m6.34 17.66-1.41 1.41"/><path d="m19.07 4.93-1.41 1.41"/>',
		warning:
			'<path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z"/><path d="M12 9v4"/><path d="M12 17h.01"/>',
		webhook:
			'<path d="M18 16.98h-5.99c-1.1 0-1.95.94-2.48 1.9A4 4 0 0 1 2 17c.01-.7.2-1.4.57-2"/><path d="m6 17 3.13-5.78c.53-.97.1-2.18-.5-3.1a4 4 0 1 1 6.89-4.06"/><path d="m12 6 3.13 5.73C15.66 12.7 16.9 13 18 13a4 4 0 0 1 0 8"/>',
		x: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
	};
	return `<svg ${common}${className ? ` class="${escapeHtml(className)}"` : ""}>${paths[name] ?? paths.layout}</svg>`;
}

function themeScript(nonce: string, interactive = false): string {
	const clickHandler = interactive
		? `
	document.addEventListener("click", (event) => {
		const target = event.target;
		if (!(target instanceof Element) || !target.closest("[data-admin-theme-toggle]")) return;
		document.dispatchEvent(new CustomEvent("basecoat:theme"));
	});`
		: "";
	return `<script nonce="${escapeHtml(nonce)}">
	(() => {
		const key = "themeMode";
		const query = matchMedia("(prefers-color-scheme: dark)");
		const storedMode = () => {
			try {
				const value = localStorage.getItem(key);
				return value === "dark" || value === "light" ? value : undefined;
			} catch {
				return undefined;
			}
		};
		const apply = (dark, persist) => {
			document.documentElement.classList.toggle("dark", dark);
			if (persist) {
				try { localStorage.setItem(key, dark ? "dark" : "light"); } catch {}
			}
		};
		const stored = storedMode();
		apply(stored ? stored === "dark" : query.matches, false);
		query.addEventListener?.("change", (event) => {
			if (!storedMode()) apply(event.matches, false);
		});
		document.addEventListener("basecoat:theme", (event) => {
			const mode = event.detail?.mode;
			apply(mode === "dark" ? true : mode === "light" ? false : !document.documentElement.classList.contains("dark"), true);
		});${clickHandler}
	})();
</script>`;
}

function escapeHtml(input: string): string {
	return input
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&#39;");
}

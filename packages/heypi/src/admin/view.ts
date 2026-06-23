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
	threads: AdminPage<AdminThreadRow>;
	body: string;
	nonce: string;
	livePage?: boolean;
	liveThreadId?: string;
	threadEvent?: string;
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
const ADMIN_CSS_HREF = "/admin/assets/admin.css?v=9";
const ADMIN_JS_HREF = "/admin/assets/basecoat.all.min.js?v=1";
const ADMIN_DOCS_HREF = "https://heypi.dev/docs";

export function page(input: PageInput): string {
	return `<!doctype html>
<html lang="en" class="overflow-x-hidden">
<head>
${themeScript(input.nonce, true)}
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(input.title)} · heypi admin</title>
<link rel="stylesheet" href="${ADMIN_CSS_HREF}">
</head>
<body class="min-h-screen overflow-x-hidden bg-background text-foreground" data-live-page="${input.livePage ? "true" : "false"}" data-live-revision="${escapeHtml(input.live.revision)}" data-live-chats-revision="${escapeHtml(input.live.chatsRevision)}" data-live-thread-id="${escapeHtml(input.liveThreadId ?? "")}" data-live-thread-revision="${escapeHtml(input.liveThreadId ? (input.live.threadRevisions[input.liveThreadId] ?? "") : "")}">
${adminSidebar(input)}
<main class="scrollbar flex h-dvh min-w-0 flex-col overflow-y-auto bg-background" data-admin-main>
	<header class="sticky top-0 z-20 flex min-w-0 items-center gap-2 border-b bg-background px-6 py-3 max-[760px]:px-4" data-admin-main-header>
		<button type="button" class="btn-sm-icon-ghost text-muted-foreground hover:text-foreground" aria-label="Toggle sidebar" data-admin-sidebar-toggle data-tooltip="Toggle sidebar" data-side="bottom">${icon("panel-left")}</button>
		<div class="min-w-0 flex-1">
			${mainHeaderTitle(input)}
		</div>
		<div class="ml-auto flex min-w-0 items-center gap-1">
			${mainAction(input)}
			${input.liveThreadId ? "" : sectionDocsLink(input.active)}
		</div>
	</header>
	<section class="min-w-0 flex-1" data-admin-page-content="${escapeHtml(input.active)}">
${input.body}
	</section>
</main>
${commandDialog(input)}
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
	return document.querySelector("[data-admin-main]");
}
function threadPanelContainer() {
	return document.querySelector("[data-admin-thread-panel]");
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
function resizeComposeText(textarea) {
	textarea.style.height = "auto";
	const next = Math.min(textarea.scrollHeight, 160);
	textarea.style.height = next + "px";
	textarea.style.overflowY = textarea.scrollHeight > 160 ? "auto" : "hidden";
}
function updateComposeText(textarea) {
	resizeComposeText(textarea);
	const form = textarea.closest("[data-admin-compose]");
	const submit = form?.querySelector("[data-admin-compose-submit]");
	if (submit instanceof HTMLButtonElement) submit.disabled = textarea.value.trim().length === 0;
}
function setupComposeTextareas(root = document) {
	root.querySelectorAll("[data-admin-compose-text]").forEach((textarea) => {
		if (textarea instanceof HTMLTextAreaElement) updateComposeText(textarea);
	});
}
function openAdminCommand() {
	const command = document.getElementById("admin-command");
	if (!(command instanceof HTMLDialogElement)) return;
	command.showModal();
	requestAnimationFrame(() => {
		const input = command.querySelector("input");
		if (input instanceof HTMLInputElement) {
			input.value = "";
			input.dispatchEvent(new Event("input", { bubbles: true }));
			input.focus();
		}
	});
}
setupComposeTextareas();
function setupThreadScroll(restore) {
	if (!liveThreadId) return;
	const threadScroll = threadScrollContainer();
	if (!(threadScroll instanceof HTMLElement)) return;
	requestAnimationFrame(() => {
		requestAnimationFrame(() => {
			const stored = sessionStorage.getItem(threadScrollKey());
			sessionStorage.removeItem(threadScrollKey());
			if (restore && stored && stored !== "bottom") threadScroll.scrollTop = Number(stored) || 0;
			else threadScrollBottom(threadScroll);
		});
	});
}
setupThreadScroll(true);
let threadWasAtBottom = true;
function setupThreadScrollTracking() {
	const threadScroll = threadScrollContainer();
	if (!(threadScroll instanceof HTMLElement)) return;
	threadWasAtBottom = threadAtBottom(threadScroll);
	threadScroll.addEventListener(
		"scroll",
		() => {
			threadWasAtBottom = threadAtBottom(threadScroll);
		},
		{ passive: true },
	);
}
setupThreadScrollTracking();
async function refreshThreadPanel() {
	if (!liveThreadId) return false;
	const panel = threadPanelContainer();
	if (!(panel instanceof HTMLElement)) return false;
	const before = threadScrollContainer();
	const followBottom = before instanceof HTMLElement ? threadWasAtBottom && threadAtBottom(before) : true;
	const scrollTop = before instanceof HTMLElement ? before.scrollTop : 0;
	const response = await fetch("/admin/threads/" + encodeURIComponent(liveThreadId) + "/_panel" + location.search, {
		headers: { accept: "text/html" },
		credentials: "same-origin"
	});
	if (!response.ok) return false;
	panel.innerHTML = await response.text();
	setupComposeTextareas(panel);
	requestAnimationFrame(() => {
		requestAnimationFrame(() => {
			const after = threadScrollContainer();
			if (!(after instanceof HTMLElement)) return;
			if (followBottom) threadScrollBottom(after);
			else after.scrollTop = scrollTop;
		});
	});
	return true;
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
		const threadChanged = Boolean(nextThreadRevision && nextThreadRevision !== currentThreadRevision);
		const shouldReload = liveThreadId ? false : true;
		if (data.chatsRevision) currentChatsRevision = data.chatsRevision;
		if (nextThreadRevision) currentThreadRevision = nextThreadRevision;
		if (liveThreadId && threadChanged && !chatsChanged) {
			void refreshThreadPanel().then((ok) => {
				if (!ok) location.reload();
			}).catch(() => location.reload());
		} else if (shouldReload || chatsChanged) {
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
	const toggle = target.closest("[data-admin-sidebar-toggle]");
	if (toggle) {
		const sidebar = document.getElementById("admin-sidebar");
		if (sidebar && typeof sidebar.toggle === "function") sidebar.toggle();
		return;
	}
	const commandOpen = target.closest("[data-admin-command-open]");
	if (commandOpen) {
		openAdminCommand();
		return;
	}
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
document.addEventListener("input", (event) => {
	const target = event.target;
	if (target instanceof HTMLTextAreaElement && target.matches("[data-admin-compose-text]")) {
		updateComposeText(target);
	}
});
document.addEventListener("keydown", (event) => {
	if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
		event.preventDefault();
		openAdminCommand();
		return;
	}
	const target = event.target;
	if (target instanceof HTMLTextAreaElement && target.matches("[data-admin-compose-text]")) {
		if (event.key === "Enter" && !event.shiftKey) {
			event.preventDefault();
			updateComposeText(target);
			if (target.value.trim()) target.form?.requestSubmit();
		}
	}
});
</script>
</body>
</html>`;
}

type AdminNavItem = {
	label: string;
	href: string;
	key: string;
	icon: string;
	count?: number;
	field?: string;
};

function adminSidebar(input: PageInput): string {
	return `<aside id="admin-sidebar" class="sidebar" data-side="left" data-initial-open="true" data-admin-sidebar>
	<nav aria-label="Admin navigation">
		<header>
			<a class="flex min-w-0 items-center gap-2 rounded-md p-2" href="/admin" aria-label="heypi">${logo("h-4 w-auto shrink-0")}</a>
		</header>
		<section id="admin-sidebar-content" class="scrollbar" data-admin-sidebar-content>
			${sidebarMenu(input)}
			${sidebarThreadList(input.threads, input.liveThreadId)}
		</section>
		<footer>
			${sidebarFooter(input)}
		</footer>
	</nav>
</aside>`;
}

function sidebarMenu(input: PageInput): string {
	const items = navItems(input.live, input.memoryFiles);
	return `<div role="group">
	<ul>
		<li><button type="button" data-admin-command-open>${icon("search")}<span>Search</span><kbd class="kbd ms-auto">⌘K</kbd></button></li>
		${items
			.filter((item) => item.key !== "chats" && item.key !== "evals")
			.map((item) => sidebarNavItem(item, input.active))
			.join("")}
	</ul>
</div>`;
}

function sidebarNavItem(item: AdminNavItem, active: string): string {
	const selected = active === item.key;
	const count =
		item.count === undefined
			? ""
			: `<span class="badge ms-auto" data-variant="secondary"${item.field ? ` data-live-field="${escapeHtml(item.field)}"` : ""}>${item.count}</span>`;
	return `<li><a href="${escapeHtml(item.href)}"${selected ? ' aria-current="page"' : ""} data-admin-sidebar-link="${escapeHtml(item.key)}">${icon(item.icon)}<span>${escapeHtml(item.label)}</span>${count}</a></li>`;
}

function sidebarThreadList(page: AdminPage<AdminThreadRow>, selectedId?: string): string {
	if (!page.rows.length) {
		return `<div role="group" aria-labelledby="admin-sidebar-threads-heading">
	<h3 id="admin-sidebar-threads-heading">Threads</h3>
	<ul>
		<li><button type="button" disabled><span>No threads yet</span></button></li>
	</ul>
</div>`;
	}
	return `${threadGroups(page.rows)
		.map(
			(group) => `<div role="group" aria-labelledby="admin-thread-group-${escapeHtml(group.key)}">
	<h3 id="admin-thread-group-${escapeHtml(group.key)}">${escapeHtml(group.label)} <span class="ml-auto font-mono">${group.rows.length}</span></h3>
	<ul>
		${group.rows.map((row) => sidebarThreadItem(row, row.id === selectedId)).join("")}
	</ul>
</div>`,
		)
		.join("")}`;
}

function sidebarThreadItem(row: AdminThreadRow, selected: boolean): string {
	return `<li><a href="${escapeHtml(threadHref(row))}"${selected ? ' aria-current="page"' : ""} data-admin-sidebar-thread="${escapeHtml(row.id)}">
	<span>${escapeHtml(threadPreview(row))}</span>
	${row.pendingApprovals ? `<span class="badge ms-auto" data-variant="secondary">${row.pendingApprovals}</span>` : ""}
</a></li>`;
}

function sidebarFooter(input: PageInput): string {
	const logout = input.auth === false ? sidebarDisabledAction("Log out", "log-out") : sidebarLogoutForm(input.csrf);
	return `<div class="flex items-center gap-2 px-2 py-1" data-admin-sidebar-footer-actions>
	<div class="flex items-center gap-1">${logout}</div>
	<div class="ms-auto flex items-center gap-1">
		<a class="btn-sm-icon-ghost text-muted-foreground hover:text-foreground" href="${ADMIN_DOCS_HREF}" target="_blank" rel="noopener noreferrer" aria-label="Docs" data-tooltip="Docs" data-side="top" data-admin-docs-link>${icon("book-text")}</a>
		<button type="button" class="btn-sm-icon-ghost text-muted-foreground hover:text-foreground" aria-label="Toggle theme" data-tooltip="Toggle theme" data-side="top" data-admin-theme-toggle>${themeIcon()}</button>
	</div>
</div>`;
}

function themeIcon(): string {
	return `<span class="block dark:hidden" data-admin-theme-icon="moon">${icon("moon")}</span><span class="hidden dark:block" data-admin-theme-icon="sun">${icon("sun")}</span>`;
}

function sidebarDisabledAction(label: string, iconName: string): string {
	return `<button type="button" class="btn-sm-icon-ghost text-muted-foreground" disabled aria-disabled="true" aria-label="${escapeHtml(label)}" data-tooltip="${escapeHtml(label)}" data-side="top" data-admin-logout>${icon(iconName)}</button>`;
}

function sidebarLogoutForm(csrf: string): string {
	return `<form method="post" action="/admin/logout" class="contents">
	<input type="hidden" name="csrf" value="${escapeHtml(csrf)}">
	<button type="submit" class="btn-sm-icon-ghost text-muted-foreground hover:text-foreground" aria-label="Log out" data-tooltip="Log out" data-side="top" data-admin-logout>${icon("log-out")}</button>
</form>`;
}

function commandDialog(input: PageInput): string {
	const items = navItems(input.live, input.memoryFiles);
	return `<dialog id="admin-command" class="command-dialog" aria-label="Admin command menu">
	<div class="command">
		<header>
			${icon("search")}
			<input id="admin-command-input" type="text" placeholder="Search admin..." autocomplete="off" autocorrect="off" spellcheck="false" aria-autocomplete="list" role="combobox" aria-expanded="true" aria-controls="admin-command-menu">
		</header>
		<div role="menu" id="admin-command-menu" aria-orientation="vertical" data-empty="No results found." class="scrollbar">
			<div role="group" aria-labelledby="admin-command-pages-heading">
				<span role="heading" id="admin-command-pages-heading">Pages</span>
				${items.map((item) => commandItem(item)).join("")}
			</div>
			${commandThreadGroup(input.threads)}
		</div>
	</div>
</dialog>`;
}

function commandItem(item: AdminNavItem): string {
	return `<a href="${escapeHtml(item.href)}" role="menuitem" data-filter="${escapeHtml(item.label)}" data-keywords="${escapeHtml(item.key)}">${icon(item.icon)}<span>${escapeHtml(item.label)}</span></a>`;
}

function commandThreadGroup(page: AdminPage<AdminThreadRow>): string {
	if (!page.rows.length) return "";
	return `<div role="group" aria-labelledby="admin-command-threads-heading">
	<span role="heading" id="admin-command-threads-heading">Threads</span>
	${page.rows
		.map(
			(row) =>
				`<a href="${escapeHtml(threadHref(row))}" role="menuitem" data-filter="${escapeHtml(threadPreview(row))}" data-keywords="${escapeHtml(`${row.provider} ${row.kind} ${row.channel} ${row.actor ?? ""}`)}"><span>${escapeHtml(threadPreview(row))}</span></a>`,
		)
		.join("")}
</div>`;
}

function mainAction(input: PageInput): string {
	if (input.liveThreadId) return "";
	if (input.active === "chats") {
		return `<a class="btn-sm" href="/admin">${icon("message-square")}New message</a>`;
	}
	return "";
}

function mainHeaderTitle(input: PageInput): string {
	const thread = input.liveThreadId ? input.threads.rows.find((row) => row.id === input.liveThreadId) : undefined;
	if (thread) return threadHeader(thread);
	return `<h1 class="truncate font-semibold" data-admin-page-title>${escapeHtml(input.title)}</h1>`;
}

function sectionDocsLink(input: string): string {
	const path: Record<string, string> = {
		approvals: "/configuration/admin/",
		configuration: "/configuration/admin/",
		jobs: "/configuration/scheduling/",
		memory: "/configuration/memory/",
	};
	const href = `${ADMIN_DOCS_HREF}${path[input] ?? ""}`;
	return `<a class="btn-sm-icon-ghost text-muted-foreground hover:text-foreground" href="${href}" target="_blank" rel="noopener noreferrer" aria-label="Docs" data-tooltip="Docs" data-side="bottom" data-admin-docs-link>${icon("book-text")}</a>`;
}

function navItems(live: AdminOverview["live"], memoryFiles: number): AdminNavItem[] {
	return [
		{ label: "Threads", href: "/admin", key: "chats", icon: "message-square" },
		{
			label: "Approvals",
			href: "/admin/approvals",
			key: "approvals",
			icon: "shield-check",
			count: live.pendingApprovals,
			field: "pendingApprovals",
		},
		{
			label: "Jobs",
			href: "/admin/jobs",
			key: "jobs",
			icon: "briefcase",
			count: live.jobs,
			field: "jobs",
		},
		{ label: "Evals", href: "/admin/evals", key: "evals", icon: "activity" },
		{ label: "Memory", href: "/admin/memory", key: "memory", icon: "database", count: memoryFiles },
		{ label: "Config", href: "/admin/configuration", key: "configuration", icon: "settings" },
	];
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
	return `<div class="grid min-w-0 gap-4">${summaryList(
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
	)}</div>`;
}

export function threadsView(
	_page: AdminPage<AdminThreadRow>,
	input: {
		checkedAt?: number;
		selected?: AdminThreadView;
		csrf?: string;
		live?: AdminOverview["live"];
	} = {},
): string {
	return `<div class="min-w-0" data-admin-chats>
	<section class="min-w-0" data-admin-thread-panel>${threadConversationPanel(input.selected, input.csrf)}</section>
</div>`;
}

export function approvalsView(page: AdminPage<Approval>, _checkedAt?: number, input: { csrf?: string } = {}): string {
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
	return `<div class="grid min-w-0 gap-4">${body}</div>`;
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

export function jobsView(page: AdminPage<AdminJob>, _checkedAt?: number): string {
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
	return `<div class="grid min-w-0 gap-4">${body}</div>`;
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
			message: "Add eval definitions under evals/ to inspect behavior checks here.",
		}),
	)}${pagination("/admin/evals", page)}`;
	return `<div class="grid min-w-0 gap-4">${card("Evals", checkedAtDescription("Loaded agent behavior eval definitions.", checkedAt), body)}</div>`;
}

export function memoryView(memory: AdminMemory, _checkedAt?: number): string {
	if (!memory.enabled) {
		return `<div class="grid min-w-0 gap-4">${emptyState({
			title: "Memory disabled",
			message:
				"This heypi app is running without durable memory. Enable memory in the app config to store context files.",
			frame: "section",
			variant: "outline",
		})}</div>`;
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
	return `<div class="grid min-w-0 gap-4">${body}</div>`;
}

function threadHeader(row: AdminThreadRow): string {
	return `<div class="flex min-w-0 items-center gap-2" data-admin-thread-header><h2 class="min-w-0 truncate text-sm font-medium" data-admin-thread-adapter>${escapeHtml(threadChannelLabel(row))}</h2>${icon("chevron-right", "size-4 shrink-0 text-muted-foreground")}<span class="min-w-0 truncate font-mono text-[13px] text-muted-foreground" data-admin-thread-id>${escapeHtml(row.id)}</span></div>`;
}

function threadGroups(rows: AdminThreadRow[]): Array<{ key: string; label: string; rows: AdminThreadRow[] }> {
	const groups = new Map<string, { key: string; label: string; rows: AdminThreadRow[] }>();
	for (const row of rows) {
		const key = `${row.kind}:${row.provider}`;
		let group = groups.get(key);
		if (!group) {
			group = { key, label: `${row.provider} · ${adapterLabel(row.kind)}`, rows: [] };
			groups.set(key, group);
		}
		group.rows.push(row);
	}
	return [...groups.values()];
}

export function threadConversationPanel(input?: AdminThreadView, csrf?: string): string {
	if (!input) {
		return `<div class="grid min-h-[calc(100vh-3.5rem)] grid-rows-[minmax(0,1fr)_auto]" data-admin-thread-empty>
	<div class="grid min-h-0 place-items-center px-4" data-admin-thread-scroll>
		${emptyState({
			title: "Select a thread",
			message: "Open a thread or send a local message.",
			variant: "plain",
		})}
	</div>
	${adminComposeForm({ csrf })}
</div>`;
	}
	return `<div class="grid min-h-[calc(100vh-3.5rem)] min-w-0 grid-rows-[minmax(0,1fr)_auto]">
	<div class="min-w-0 pb-4" data-admin-thread-scroll>${threadConversation(input, csrf)}</div>
	${adminComposeForm({ csrf, threadId: input.thread.id })}
</div>`;
}

function adminComposeForm(input: { csrf?: string; threadId?: string; compact?: boolean } = {}): string {
	const compact = input.compact === true;
	return `<form class="sticky bottom-0 z-10 min-w-0 bg-background py-3 ${compact ? "pt-3" : "w-full"}" method="post" action="/admin/messages" data-admin-compose>
	<input type="hidden" name="csrf" value="${escapeHtml(input.csrf ?? "")}">
	${input.threadId ? `<input type="hidden" name="threadId" value="${escapeHtml(input.threadId)}">` : ""}
	<label class="sr-only" for="${input.threadId ? "admin-compose-thread" : compact ? "admin-compose-sidebar" : "admin-compose-new"}">Message</label>
	<div class="${adminThreadColumnClass()}">
		<div class="input-group w-full" data-orientation="vertical" data-admin-compose-group>
			<textarea id="${input.threadId ? "admin-compose-thread" : compact ? "admin-compose-sidebar" : "admin-compose-new"}" data-control class="min-h-10 resize-none overflow-hidden text-sm leading-5" rows="1" name="text" placeholder="Message..." required data-admin-compose-text></textarea>
			<footer data-align="block-end" class="flex justify-end p-2">
				<button class="btn-sm-icon" type="submit" aria-label="Send message" disabled data-admin-compose-submit data-tooltip="Send" data-side="top" data-align="end">${icon("arrow-up")}</button>
			</footer>
		</div>
	</div>
</form>`;
}

function adminThreadColumnClass(): string {
	return "mx-auto w-full max-w-3xl min-w-0 px-4";
}

function threadConversation(input: AdminThreadView, csrf: string | undefined): string {
	const rows = [...input.timeline].sort(chronologicalActivitySort);
	const selectedKey = input.event ?? (input.selected ? activityEvent(input.selected) : undefined);
	if (!rows.length) {
		return emptyState({
			title: "No messages yet",
			message: "Messages, approvals, and tool calls for this thread will show up here.",
			frame: "section",
			variant: "plain",
		});
	}
	return `<div class="${adminThreadColumnClass()} grid gap-3 py-3" data-admin-thread-view="timeline">${rows
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
		<div class="grid max-w-[min(42rem,80%)] min-w-0 gap-2 rounded-lg bg-accent px-4 py-3">
			<div class="grid min-w-0 gap-2 text-sm leading-6">${body}</div>
			<div class="text-right">${meta}</div>
		</div>
	</article>`;
	}
	return `<article id="${escapeHtml(eventDomId(row))}" data-admin-message-role="assistant"${selectedAttr(selected)} class="grid min-w-0 justify-items-start px-2">
		<div class="grid max-w-[min(42rem,80%)] min-w-0 gap-2 rounded-lg border bg-background px-4 py-3 text-foreground">
		<div class="grid min-w-0 gap-2 text-sm leading-6">${body}</div>
		${meta}
	</div>
</article>`;
}

function chatContextRow(row: AdminActivityRow, selected: boolean, csrf?: string): string {
	const details = chatContextDetails(row, csrf);
	const teaser = chatContextTeaser(row);
	return `<details id="${escapeHtml(eventDomId(row))}" data-admin-context-row="${row.kind}"${selectedAttr(selected)} class="group rounded-sm px-2 py-2 text-sm hover:bg-muted/40">
		<summary class="flex max-w-full min-w-0 items-center gap-2 overflow-hidden" data-admin-context-summary>
		${cellHtml(activityBadge(row))}
		<span class="shrink-0 font-medium">${escapeHtml(teaser.title)}</span>
		<span class="min-w-0 flex-1 truncate text-muted-foreground">${escapeHtml(teaser.meta ?? "")}</span>
		<span class="shrink-0 text-xs text-muted-foreground">${relativeTimeHtml(row.time)}</span>
		${icon("chevron-right", "text-muted-foreground transition group-open:rotate-90")}
	</summary>
	${details}
</details>`;
}

function chatContextTeaser(row: AdminActivityRow): { title: string; meta?: string } {
	if (row.kind === "run") {
		return { title: `Run ${lifecycleVerb(row.state)}`, meta: firstText(row.title, row.summary) };
	}
	if (row.kind === "call") {
		const meta = [row.title, row.durationMs ? duration(row.durationMs) : undefined].filter(Boolean).join(" · ");
		return { title: `Tool ${lifecycleVerb(row.state)}`, meta };
	}
	if (row.kind === "approval") {
		return { title: `Approval ${lifecycleVerb(row.state)}`, meta: firstText(row.title, row.summary) };
	}
	if (row.kind === "event") {
		const event = eventTeaser(row);
		return event;
	}
	return { title: row.title, meta: row.summary };
}

function eventTeaser(row: AdminActivityRow): { title: string; meta?: string } {
	const type = row.eventType ?? row.title;
	if (!type.includes(".")) {
		return { title: row.title, meta: firstText(row.summary && !looksJson(row.summary) ? row.summary : undefined) };
	}
	const [category = "trace", action = row.state] = type.split(".", 2);
	const categoryTitle = eventCategoryLabel(category);
	const actionTitle = action ? lifecycleVerb(action) : lifecycleVerb(row.state);
	const data = eventData(row);
	const tool = stringValue(data?.tool);
	const meta = firstText(tool, row.summary && !looksJson(row.summary) ? row.summary : undefined);
	return { title: `${categoryTitle} ${actionTitle}`, meta };
}

function stateVerb(input: string): string {
	const labels: Record<string, string> = {
		active: "active",
		approved: "approved",
		cancelled: "cancelled",
		completed: "completed",
		denied: "denied",
		done: "completed",
		expired: "expired",
		failed: "failed",
		pending: "pending",
		pending_approval: "pending",
		received: "received",
		rejected: "rejected",
		requested: "requested",
		resolved: "resolved",
		running: "running",
		sent: "sent",
		started: "started",
		succeeded: "succeeded",
		success: "succeeded",
	};
	return labels[input] ?? input.replace(/_/gu, " ");
}

function lifecycleVerb(input: string): string {
	if (input === "running") return "started";
	return stateVerb(input);
}

function eventData(row: AdminActivityRow): Record<string, unknown> | undefined {
	const data = activityDetail(row, "Data")?.value;
	if (!data) return undefined;
	try {
		const parsed = JSON.parse(data) as unknown;
		return parsed && typeof parsed === "object" && !Array.isArray(parsed)
			? (parsed as Record<string, unknown>)
			: undefined;
	} catch {
		return undefined;
	}
}

function stringValue(input: unknown): string | undefined {
	return typeof input === "string" && input.trim() ? input : undefined;
}

function firstText(...values: Array<string | undefined>): string | undefined {
	return values.find((value) => value?.trim());
}

function looksJson(input: string): boolean {
	return /^[[{]/u.test(input.trim());
}

function eventCategoryLabel(input: string): string {
	const normalized = input.replace(/[_-]+/gu, " ").trim();
	return normalized ? normalized[0]?.toUpperCase() + normalized.slice(1) : "Event";
}

function chatContextDetails(row: AdminActivityRow, csrf?: string): string {
	const detailLabels =
		row.kind === "event"
			? [
					"Trace",
					"Sequence",
					"Turn",
					"Call",
					"Approval",
					"Job run",
					"Eval",
					"Assertions",
					"Mode",
					"Characters",
					"Tools",
					"Error",
					"Reason",
					"Data",
				]
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

function chronologicalActivitySort(left: AdminActivityRow, right: AdminActivityRow): number {
	return left.time - right.time || left.kind.localeCompare(right.kind) || left.id.localeCompare(right.id);
}

function threadChannelLabel(row: AdminThreadRow): string {
	return row.provider || row.channel || row.kind || "thread";
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

function activityBadge(row: AdminActivityRow): Cell {
	const bucket = activityBucket(row);
	return {
		html: `<span class="badge-secondary ${activityBucketBg(bucket)}">${escapeHtml(activityBucketLabel(row, bucket))}</span>`,
	};
}

function statusBadge(state: string): Cell {
	return {
		html: `<span class="badge-secondary ${stateBg(state)}">${escapeHtml(stateLabel(state))}</span>`,
	};
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

type ActivityBucket = "activity" | "approval" | "tool";

function activityBucket(row: AdminActivityRow): ActivityBucket {
	if (row.kind === "approval") return "approval";
	if (row.kind === "call") return "tool";
	const eventName = row.eventType ?? row.title;
	if (row.kind === "event" && eventName.startsWith("tool.")) return "tool";
	if (row.kind === "event" && eventName.startsWith("approval.")) return "approval";
	return "activity";
}

function activityBucketLabel(row: AdminActivityRow, bucket: ActivityBucket): string {
	if (bucket === "activity") return activityLabel(row);
	const labels: Record<ActivityBucket, string> = {
		activity: "Event",
		approval: "Approval",
		tool: "Tool",
	};
	return labels[bucket];
}

function activityLabel(row: AdminActivityRow): string {
	if (row.kind === "run") return "Run";
	if (row.kind !== "event") return "Event";
	const category = eventCategory(row.eventType ?? row.title);
	return eventCategoryLabel(category);
}

function eventCategory(input: string): string {
	if (input.includes(".")) return input.split(".", 1)[0] ?? "";
	const [first = ""] = input.trim().split(/\s+/u, 1);
	const normalized = first.toLowerCase();
	return ["approval", "message", "model", "tool", "turn"].includes(normalized) ? normalized : "event";
}

function activityBucketBg(bucket: ActivityBucket): string {
	const classes: Record<ActivityBucket, string> = {
		activity: "bg-zinc-100 text-zinc-950 dark:bg-zinc-900 dark:text-zinc-50",
		approval: "bg-amber-100 text-amber-950 dark:bg-amber-900 dark:text-amber-50",
		tool: "bg-cyan-100 text-cyan-950 dark:bg-cyan-950 dark:text-cyan-50",
	};
	return classes[bucket];
}

function stateBg(state: string): string {
	if (["active", "approved", "completed", "done", "succeeded", "success"].includes(state)) {
		return "bg-emerald-100 text-emerald-950 dark:bg-emerald-900 dark:text-emerald-50";
	}
	if (["blocked", "pending", "pending_approval", "running"].includes(state)) {
		return "bg-amber-100 text-amber-950 dark:bg-amber-900 dark:text-amber-50";
	}
	if (["cancelled", "denied", "expired", "failed", "rejected", "unauthorized"].includes(state)) {
		return "bg-red-100 text-red-950 dark:bg-red-900 dark:text-red-50";
	}
	if (["idle", "paused", "skipped"].includes(state)) {
		return "bg-zinc-100 text-zinc-950 dark:bg-zinc-900 dark:text-zinc-50";
	}
	return "bg-muted";
}

function adapterList(adapters: AdminOverview["adapters"]): Cell {
	if (!adapters.length) return mono("none");
	return html(
		`<span class="flex min-w-0 flex-wrap items-center gap-2">${adapters
			.map((adapter) => {
				const permission = adapterPermissionSummary(adapter.permissions);
				const title = [adapter.kind, permission].filter(Boolean).join(", ");
				return `<span class="inline-flex min-w-0 items-center gap-1.5" title="${escapeHtml(title)}"><span class="min-w-0 truncate font-mono text-[13px]">${escapeHtml(adapter.name)}</span>${permission ? `<span class="text-xs text-muted-foreground">${escapeHtml(permission)}</span>` : ""}</span>`;
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
	return html(
		`<div class="max-w-full whitespace-pre-wrap break-words [overflow-wrap:anywhere]">${escapeHtml(input)}</div>`,
	);
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
		"arrow-up": '<path d="m5 12 7-7 7 7"/><path d="M12 19V5"/>',
		"arrow-up-right": '<path d="M7 7h10v10"/><path d="M7 17 17 7"/>',
		"book-text":
			'<path d="M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H19a1 1 0 0 1 1 1v18a1 1 0 0 1-1 1H6.5a1 1 0 0 1 0-5H20"/><path d="M8 11h8"/><path d="M8 7h6"/>',
		briefcase:
			'<path d="M16 20V4a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16"/><rect width="20" height="14" x="2" y="6" rx="2"/>',
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
		"message-square": '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
		minus: '<path d="M5 12h14"/>',
		"panel-left": '<rect width="18" height="18" x="3" y="3" rx="2"/><path d="M9 3v18"/>',
		pause: '<path d="M10 4v16"/><path d="M14 4v16"/>',
		refresh:
			'<path d="M21 12a9 9 0 0 0-9-9 9.8 9.8 0 0 0-6.7 2.7L3 8"/><path d="M3 3v5h5"/><path d="M3 12a9 9 0 0 0 9 9 9.8 9.8 0 0 0 6.7-2.7L21 16"/><path d="M16 16h5v5"/>',
		route: '<circle cx="6" cy="19" r="3"/><path d="M9 19h8.5a3.5 3.5 0 0 0 0-7h-11a3.5 3.5 0 0 1 0-7H15"/><circle cx="18" cy="5" r="3"/>',
		search: '<path d="m21 21-4.34-4.34"/><circle cx="11" cy="11" r="8"/>',
		send: '<path d="m22 2-7 20-4-9-9-4Z"/><path d="M22 2 11 13"/>',
		settings:
			'<path d="M9.671 4.136a2.34 2.34 0 0 1 4.659 0 2.34 2.34 0 0 0 3.319 1.915 2.34 2.34 0 0 1 2.33 4.033 2.34 2.34 0 0 0 0 3.831 2.34 2.34 0 0 1-2.33 4.033 2.34 2.34 0 0 0-3.319 1.915 2.34 2.34 0 0 1-4.659 0 2.34 2.34 0 0 0-3.32-1.915 2.34 2.34 0 0 1-2.33-4.033 2.34 2.34 0 0 0 0-3.831 2.34 2.34 0 0 1 2.33-4.033 2.34 2.34 0 0 0 3.32-1.915"/><circle cx="12" cy="12" r="3"/>',
		"shield-check":
			'<path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/><path d="m9 12 2 2 4-4"/>',
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

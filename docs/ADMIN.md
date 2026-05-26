# Admin

The admin panel serves a small web UI under `/admin/*`. It is disabled by default.

```ts
createHeypi({
	// ...
	admin: true,
});
```

Default binding is `127.0.0.1:3000`. On loopback, heypi logs a one-time login URL that expires after five minutes.

Admin uses the same shared HTTP listener as Slack HTTP mode and webhook adapters. Configure that listener with top-level `http`.

For local UI testing only, auth can be disabled:

```ts
createHeypi({
	// ...
	admin: { auth: false },
});
```

That mode is only accepted on loopback hosts and should not be used for production.

The Slack DevOps example uses `admin: true`, so `pnpm run dev:slack` prints a one-time admin login link at startup.

heypi also writes a local control file at `.heypi/admin-control.json`. If the startup link expires while the process is still running, mint a fresh one:

```sh
heypi admin link
```

The command reads the control file, calls the running admin server, and prints a fresh single-use URL. Use `--control <path>` when the app configured a custom `admin.controlPath`, or `--url <url>` when the admin server is not at the URL recorded in the control file.

For non-loopback binding, put admin behind HTTPS and an access-controlled proxy. A manual secret is optional; without one, login is only through one-time links minted from the local control file.

```ts
createHeypi({
	// ...
	http: { host: "0.0.0.0", port: 3000 },
	admin: {
		secret: process.env.HEYPI_ADMIN_SECRET!,
		secureCookies: true,
	},
});
```

Do not expose admin over plain HTTP.

## Pages

- `/admin`: default activity tab with recent approvals, runs, calls, and jobs
- `/admin/approvals`: pending approvals, paged with a maximum page size of 50
- `/admin/jobs`: scheduled jobs configured through app-level `jobs`, paged with a maximum page size of 50
- `/admin/memory`: read-only, paged memory file table with escaped details
- `/admin/configuration`: agent, model, runtime, HTTP, adapter, memory, and process start summary

Memory is durable model context, not chat history or an operational queue. The memory tab lists stored memory files by scope and opens file contents in a details dialog. This matters for `memory.scope: "user"`, where each user can have a separate memory file. The configuration tab shows whether memory is enabled, how it is scoped, and who can write it.

Fresh login links are minted with `heypi admin link`, not from a browser page.

The browser opens an SSE stream at `/admin/events`. Overview counters update live, and activity-oriented pages refresh when the server-side revision changes.

## UI assets

Admin CSS is authored in `src/admin/style.css` and compiled with Tailwind CSS plus Basecoat into static assets under `src/admin/assets/`. The server only serves static assets; it does not run Tailwind.

```sh
pnpm run build:admin-css
```

`pnpm run build` copies those static assets to `dist/admin/assets/` for packaging. Use `pnpm run build:admin-css` only when regenerating admin CSS, or `pnpm run dev:admin-css` while actively editing admin styles.

## Security

- `/admin` is a reserved route prefix. Non-admin adapters cannot register routes under it.
- `admin: { auth: false }` removes login/session checks and is restricted to loopback hosts.
- Sessions are opaque random tokens stored only as hashes in process memory.
- One-time login links are opaque tokens stored only as hashes in process memory. They are single-use and expire.
- `.heypi/admin-control.json` contains a generated local bearer token used by `heypi admin link`. Keep it out of source control.
- Unsafe actions require a CSRF token and same-origin check.
- Memory is shown as untrusted text, not rendered Markdown.
- Admin CSS and JavaScript are served locally from `/admin/assets/*`. Admin does not load UI assets from a CDN.
- v1 does not include chat-issued admin links, approval execution from the web UI, config editing, secret editing, or shell access.

# Admin

Admin is a local web panel for inspecting a running heypi app. It shows chats, thread timelines, approvals, scheduled jobs, memory files, configuration, calls, runs, adapters, and activity.

Admin is disabled by default and is served under `/admin/*` when enabled.

## Config

Enable admin:

```ts
createHeypi({
	state: { root: "./state" },
	admin: true,
	// ...adapters, agent, runtime
});
```

By default, admin binds through heypi's shared HTTP listener on loopback. On startup, heypi logs a one-time login URL that expires after 5 minutes.

Use top-level `http` when you need a specific host or port:

```ts
createHeypi({
	state: { root: "./state" },
	http: { host: "127.0.0.1", port: 3000 },
	admin: true,
	// ...adapters, agent, runtime
});
```

For local development only, auth can be disabled:

```ts
createHeypi({
	state: { root: "./state" },
	admin: { auth: false },
	// ...adapters, agent, runtime
});
```

`auth: false` is only valid on loopback. Never set it on a public host.

For non-loopback access, put admin behind HTTPS and an access-controlled proxy:

```ts
createHeypi({
	state: { root: "./state" },
	http: { host: "0.0.0.0", port: 3000 },
	admin: {
		secret: process.env.HEYPI_ADMIN_SECRET!,
		secureCookies: true,
	},
	// ...adapters, agent, runtime
});
```

Do not expose admin over plain HTTP. `secureCookies: true` is required outside loopback.

Notes:

- `state.root` is the admin auth boundary. Use a separate state root when admin access should be separated.
- Admin state is stored under `<state.root>/admin/`.
- `/admin` is a reserved route prefix. User adapters cannot register routes under it.
- Admin is read-only for agent state in this release. It does not edit config, edit secrets, execute approvals, or provide shell access.

## CLI

Mint a fresh one-time admin login link:

```bash
npx @hunvreus/heypi admin link
```

When `@hunvreus/heypi` is installed locally in the app, you can also use:

```bash
pnpm exec heypi admin link
npm exec heypi -- admin link
```

Useful flags:

| Flag | Purpose |
| --- | --- |
| `--state ./state` | Use a specific state root when running outside the app folder. |
| `--url http://127.0.0.1:3000` | Override the discovered admin URL, for example through a tunnel or proxy. |
| `--pid <pid>` | Select one admin server when multiple descriptors exist. |
| `--json` | Print machine-readable output. |

`admin link` reads local admin state, verifies the discovered server descriptor, signs a short-lived URL, and prints it. It does not ask the running server to mint tokens.

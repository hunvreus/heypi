# Admin

Admin is a local web panel for inspecting and operating a running heypi app. It shows chats, thread timelines, approvals, scheduled jobs, memory files, configuration, approval policy, active approval bypasses, calls, runs, adapters, and activity.

In dev workflows, the Chats view can send local test messages through the same handler path used by adapters. The Chats sidebar also shows a live pulse for pending approvals, running runs, jobs, and refresh time.

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

By default, admin binds to its own loopback listener at `127.0.0.1:4321`. On startup, heypi logs a one-time login URL that expires after 5 minutes.

Use `admin.http` when you need a specific admin host or port. Use `port: 0` for local development when you want the OS to pick a free port:

```ts
createHeypi({
  state: { root: "./state" },
  admin: {
    http: { host: "127.0.0.1", port: 0 },
  },
  // ...adapters, agent, runtime
});
```

heypi logs the actual bound port and one-time admin login link at startup. Use a fixed port when a reverse proxy, tunnel, or external provider needs a stable URL.

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
    http: { host: "127.0.0.1", port: 4321 },
    secret: process.env.HEYPI_ADMIN_SECRET!,
  },
  // ...adapters, agent, runtime
});
```

With this shape, public webhooks bind on `0.0.0.0:3000`, while admin stays reachable only from the server itself. Access it through SSH port forwarding, VPN, or a reverse proxy with its own authentication.

If you intentionally bind admin to a non-loopback host, keep `auth` enabled, set a strong `secret`, put it behind HTTPS, and set `secureCookies: true`. Do not expose admin over plain HTTP.

Notes:

- `state.root` is the admin auth boundary. Use a separate state root when admin access should be separated.
- Admin state is stored under `<state.root>/admin/`.
- `/admin` is a reserved route prefix. User adapters cannot register routes under it.
- Admin does not edit config, edit secrets, or provide shell access. Its write surface is limited to local chat messages for dev testing, approval approve/deny actions, and thread cancel/status controls.

## CLI

Mint a fresh one-time admin login link:

```bash
heypi admin link
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
| `--url http://127.0.0.1:4321` | Override the discovered admin URL, for example through a tunnel or proxy. |
| `--pid <pid>` | Select one admin server when multiple descriptors exist. |
| `--json` | Print machine-readable output. |

`admin link` reads local admin state, verifies the discovered server descriptor, signs a short-lived URL, and prints it. It does not ask the running server to mint tokens.

# Admin

Admin is a local web panel for inspecting and operating a running heypi app. It shows chats, thread timelines, approvals, scheduled jobs, eval definitions, memory files, configuration, approval policy, active approval bypasses, calls, runs, adapters, and activity.

In dev workflows, the Chats view can send local test messages through the same handler path used by adapters. Thread pages show summarized conversation by default, can expand to full trace logs, and expose cancel/status thread actions when a turn is active. The Chats sidebar groups conversations by adapter, supports filtering, and shows a live pulse for pending approvals, running runs, jobs, and refresh time.

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
- Local dev test threads are hidden from admin thread lists by default. Set `admin: { localThreads: true }` when you want those loopback test conversations visible beside real adapter conversations.
- Admin does not edit config, edit secrets, or provide shell access. Its write surface is limited to local chat messages for dev testing, approval approve/deny actions, and thread cancel/status controls.

## Views

| View | Purpose |
| --- | --- |
| Chats | Inspect conversations, messages, model events, tool calls, approvals, and trace events. Send local dev messages when using admin for local testing. |
| Approvals | Review pending approval requests and submit approve/deny decisions through the same handler path used by chat commands. |
| Jobs | Inspect configured scheduled and heartbeat jobs, targets, next run times, and recent run state. |
| Evals | Inspect loaded eval definitions, tags, expectations, timeouts, and full prompts. |
| Memory | Inspect durable memory files by scope, preview content, and copy full file details. |
| Config | Inspect app, adapter, runtime, approval, task, memory, and admin configuration summaries. |

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

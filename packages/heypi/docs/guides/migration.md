# Migration guide

Use this guide when upgrading an app to `0.2.0-beta.0`. This release includes breaking config and file-convention changes. Read the full root `CHANGELOG.md` before upgrading production bots.

## Before upgrading

1. Stop the running heypi process.
2. Back up `state/` and `workspace/`.
3. Update packages.
4. Run diagnostics before starting traffic again:

```bash
npm exec heypi -- doctor --boot --env .env --db ./state/heypi.db --runtime-root ./workspace
```

## Agent files

Rename old prompt convention files:

```text
agent/AGENTS.md -> agent/instructions.md
agent/SOUL.md   -> merge into agent/instructions.md
agent/SYSTEM.md -> agent/system.md
```

`instructions.md` is the primary app instruction file. `system.md` is optional and replaces heypi's generated system prompt when present.

## Built-in tools

Move built-in runtime tools from `tools` to `builtinTools`:

```ts
// Before
loadAgent("./agent", {
  tools: defaultTools(),
});

// After
loadAgent("./agent", {
  builtinTools: defaultTools(),
});
```

Use `tools` only for trusted authored JavaScript tools. `loadAgent("./agent")` discovers authored tools from `agent/tools/` by default.

## Agent id

`loadAgent()` now defaults the durable agent id to `default`. If an existing app relied on the old folder-basename id and must keep reading the same persisted threads, approvals, jobs, and traces, set `id` explicitly:

```ts
loadAgent("./agent", {
  id: "agent",
});
```

New apps should usually keep the `default` id.

## Adapter responses

Response placement moved into adapter-local `response` objects.

Slack:

```ts
// Before
slack({
  reply: "thread",
  replyBroadcast: false,
});

// After
slack({
  response: { placement: "thread", broadcast: false },
});
```

Discord and Telegram use the same `response.placement` shape for their supported placements. See each adapter page for provider-specific options.

## Admin HTTP

Admin no longer shares the public adapter HTTP listener. It has its own `admin.http`, defaulting to `127.0.0.1:4321`.

```ts
createHeypi({
  http: { host: "0.0.0.0", port: 3000 },
  admin: {
    http: { host: "127.0.0.1", port: 4321 },
    secret: process.env.HEYPI_ADMIN_SECRET!,
  },
});
```

`heypi dev` enables admin by default when `admin` is omitted. `heypi start` does not; set `admin: true` or `admin: { ... }` explicitly when you want admin in normal runtime.

## Evals

Behavior eval discovery moved to root `evals/`:

```text
agent/evals/ -> evals/
```

Author eval files with `defineEval()` from `@hunvreus/heypi/authoring`, then inspect them with:

```bash
npm exec heypi -- eval check --evals ./evals
```

## Reply URLs

Webhook `replyUrl` callbacks require HTTPS by default. For stricter callback routing, prefer `replyUrls` or `replyOrigins` allowlists. Plain HTTP callbacks require `unsafeReplyHttp: true` and should be limited to trusted local or private networks.

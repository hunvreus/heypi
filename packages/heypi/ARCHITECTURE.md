# Architecture

Maintainer reference for heypi internals. For app setup, start with [`README.md`](README.md), [`docs/index.md`](docs/index.md), or an adapter guide under [`docs/`](docs/).

heypi is a long-running Node.js process around Pi. It adds chat adapters, durable state, approvals, scheduling, scoped command/file tools, attachments, and admin/runtime integration.

## System Shape

- One Node process owns adapters, scheduling, state, and runtime access.
- Provider events are normalized into `Inbound` messages.
- The handler creates durable turns and calls Pi.
- Pi stores transcripts; SQLite stores operational and audit state.
- Tools execute through scoped runtime roots and approval policy.
- Safety uses explicit boundaries: allowlists, locks, approvals, runtime isolation, and audit rows.

## Startup Model

```text
createHeypi(config)
  store.setup()
  runtime = createRuntime(config.runtime)
  scopedRuntimes = new ScopedRuntimeRegistry(config.runtime)
  callRunner = new CallRunner(...)
  agent = new PiAgent(...)
  handler = createHandler(...)
  http = createHttpServerRegistry(...)
  adapters[].start({ handler, logger, attachments, http })
  http.listen()
  scheduler.start()
```

`runHeypi(app)` installs `SIGINT`/`SIGTERM` handlers and releases the app lock during shutdown. `app.stop()` stops the scheduler and adapters, waits for active runs, then cancels survivors after the drain timeout.

## Main Boundaries

### App

`src/app.ts` is composition only. It wires the store, runtime, call runner, Pi agent, handler, adapters, attachments, admin adapter, HTTP registry, and scheduler.

The app-level lock prevents two processes with the same store from running the same agent at once.

### Config

`src/config.ts` defines the public config API and `agentFrom()` folder convention:

```text
agent/
  SOUL.md
  SYSTEM.md
  AGENTS.md
  skills/
  extensions/
```

`SOUL.md` sets identity and voice. `AGENTS.md` sets operating rules. `SYSTEM.md` is a full runtime-prompt override. Missing `SOUL.md` falls back to a concise built-in identity. The model must be passed explicitly or through `HEYPI_MODEL`.

Programmatic `context` providers run once per turn and append compact dynamic prompt blocks. The handler also injects provider/channel/thread/sender context when available.

### Adapters

Adapters under `src/io/` translate provider events into `Inbound` messages and render `Outbound` replies, approvals, progress, streams, and attachments.

Slack, Telegram, and Discord share `runChatMessage()` after provider-specific allow/trigger checks. Provider lifecycle, buttons/callbacks, attachment transport, and error UX stay in each adapter.

Third-party adapters should implement the public `Adapter` interface from `@hunvreus/heypi/adapter`. The built-in chat adapters are concrete provider integrations, not reusable base classes.

HTTP adapters register routes on the shared Node listener. Routes use the top-level `http` host/port, defaulting to `127.0.0.1:3000`. Duplicate or ambiguous routes fail at startup. `/admin` is reserved.

```ts
type Adapter = {
  name: string;
  kind: string;
  start(input: AdapterStart): Promise<void>;
  send?(target: AdapterTarget, out: Outbound, input?: AdapterStart): Promise<void>;
  stop?(): Promise<void>;
};
```

`name` is the durable adapter instance id stored as `provider`. `kind` is the implementation type, such as `slack` or `webhook`. Duplicate names fail startup.

### Handler

`src/io/handler.ts` is the only place where provider messages become durable turns. It normalizes text and attachments, parses control commands, creates or loads threads, de-duplicates events, locks the thread, handles approvals/cancel/status, writes audit rows, and calls Pi.

Same-thread messages during an active turn use `task.busy`:

- `steer`: inject into the active Pi session.
- `followUp`: queue after the current assistant reply.
- `reject`: return a public acknowledgement without calling Pi.

Pending approvals reject new asks until approved or denied. Cancel requests follow `task.cancel`.

### Pi Runtime

`src/runtime/pi-agent.ts` adapts heypi threads to Pi `AgentSession`s. Pi `SessionManager` is the transcript store. SQLite rows are audit/search/status data and are not replayed as provider history.

heypi does not expose Pi's raw tool runtime directly. It registers Pi-compatible tools backed by the configured heypi runtime and call runner.

### Tools And Runtime

`src/core/calls.ts` owns tool policy, approvals, execution queueing, and call audit rows:

```text
Pi tool call
  -> CallRunner
  -> policy / confirm check
  -> optional approval row
  -> runtime queue
  -> runtime execution
  -> call audit row
  -> optional Pi continuation
```

Core tools and custom `tool()` definitions use the same confirmation path. Text commands and provider-native buttons resolve to the same approval path. Custom `tool()` code runs as trusted host-side JavaScript; tools use the selected runtime explicitly through their execution context when they need command or file work.

`src/runtime/` owns command and file access. One runtime backend or runtime provider is configured per app, and each turn resolves a scoped workspace root:

- `just-bash`: default production runtime.
- `guarded-bash`: host bash with regex guardrails.
- `host-bash`: host bash; unsafe/dev/admin mode.
- `@hunvreus/heypi-runtime-docker`: external Docker provider with one warm container per runtime scope.
- `@hunvreus/heypi-runtime-gondolin`: external Gondolin provider with one warm VM per runtime scope.

`scope` controls workspace sharing: `channel` by default, or `user`, `adapter`, or `agent`. `runtime.scope` can override that runtime/workspace sharing policy independently from memory and skills. File tools enforce size, traversal, and symlink escape limits. `just-bash` disables network by default. Managed runtimes are implemented as `RuntimeProvider`s and can keep scoped runtimes warm until idle timeout, provider shutdown, or explicit management calls. Docker and Gondolin default to a 10-minute idle timeout; `idleMs: false` disables idle shutdown.

### Memory

Memory is optional durable context, not transcript storage. When enabled, heypi stores one `MEMORY.md` per memory scope and injects it before the model turn.

Memory writes are controlled by `memory.writePolicy`. The default becomes `approvers` when adapter approvers or admins are configured. Secret and prompt-injection checks are hygiene only; app authors should treat memory as user-influenced context.

### Scoped Skills

Skills are optional durable procedures. When enabled, heypi stores one `SKILL.md` per skill under `skills/scopes/<scope-key>/<skill>/`, injects a compact skill catalog, and exposes `skill_list`, `skill_read`, `skill_write`, `skill_patch`, and `skill_delete`.

Skill writes are controlled by `skills.writePolicy`. Defaults are conservative: writes are `approvers` only when adapter approvers or admins are configured, otherwise `off`. Skills are user-authored guidance, not trusted policy. heypi does not include registry install/sync or supporting-file tools for skills yet.

### Secrets

Secret requests are optional encrypted handoffs. When enabled, the agent can call `secret_request` with one or more named fields. heypi generates a request-scoped RSA keypair, sends only the public key in the browser link, decrypts the pasted encrypted blob locally, and writes values as scoped runtime files under `.secrets/`.

The hosted page at `heypi.dev/secret` is static client-side code. Apps can self-host the same page with `secrets.url` and `serve: true`; heypi serves it at the URL path.

Pending secret requests are process-local because they contain the request private key. Persisting them needs an explicit key-wrapping or KMS design. Decrypted values are saved through the secret boundary into the active runtime workspace; they are not written to the database or generic workspace.

### Store

`src/store/` defines store interfaces and the SQLite implementation. The store persists thread routes, message audit/search/status rows, turns, calls, approvals, jobs, job runs, and locks.

Apps must set `state.root`. The default SQLite path is `<state.root>/heypi.db`. Admin state lives under `<state.root>/admin/`. Pi session JSONL files live under the app runtime root.

SQLite supports local single-process deployments. Multi-instance deployments need a shared durable store with lock semantics. Custom stores should implement `transaction()` for atomic handler, call, and scheduler updates.

### Workspace Store

`src/workspace/` defines the file-shaped durability boundary for heypi-managed workspace state. The local implementation stores files under the runtime root and rejects absolute paths, parent traversal, and symlink escapes.

Memory, skills, and inbound attachment files use the workspace internally. The default local store preserves existing runtime-root behavior, so memory and skills remain visible to runtime file tools.

Pi session JSONL files, runtime secret files, arbitrary runtime working files, and outbound attachment upload resolution use filesystem paths under the configured runtime workspace. heypi assumes deployments provide a durable workspace filesystem when those files must survive restart, sleep, or redeploy. For platform-specific ephemeral disks, use that platform's persistent volume or filesystem mount rather than heypi-managed file synchronization. Secret request durability needs a separate encrypted pending-request design, not generic file storage.

### Scheduler

`src/core/scheduler.ts` runs `cron` and `heartbeat` jobs. Scheduled turns reuse the same handler path as inbound messages with `scheduled: true`. Adapters that support scheduled outbound jobs must implement `send()`.

### Attachments

`src/io/attachments.ts` keeps inbound uploads in a scoped attachment tree under `runtime.root/attachments/scopes/<scope-key>`. Attachment refs from another scope are rejected under the default `channel` scope.

Supported images go to Pi as image inputs. Text-like files are inlined. Optional document conversion uses the configured local converter. Unsupported or failed conversions remain attachment references.

Outbound generated files are explicit. The built-in `attach` tool records a file from the current scoped runtime workspace, and adapters resolve/upload it with the final reply. heypi does not automatically upload every file the agent writes.

### Delivery And Streaming

`src/io/delivery.ts` serializes sends and retries provider rate limits with backoff per adapter instance.

`src/io/reply-stream.ts` handles optional draft replies while Pi emits text deltas. Confirmed tool calls stop drafts before approval UI. Continuations can start a new draft stream after approval.

## Request Flow

```text
provider event
  -> adapter allowlist + trigger check
  -> handler(Inbound)
  -> thread + message + turn persistence
  -> PiAgent.ask()
  -> Pi SessionManager + heypi tools
  -> CallRunner
  -> runtime / approval / continuation
  -> audit persistence
  -> adapter sends Outbound
```

## Security Model

- provider allowlists filter delivered events
- thread locks prevent overlapping turns in one conversation
- tool calls and approvals are audited
- dangerous bash commands can be blocked or approval-gated
- file tools are scoped and size-limited
- `just-bash` is the safe default runtime
- `guarded-bash` and `host-bash` execute on the host and are unsafe/dev/admin modes
- startup warnings flag risky shared-bot posture: host runtimes, public HTTP binds, missing approvers for risky tools, and adapters without allow filters

## Supported Deployments

Supported:

- long-running Node process
- Slack Socket Mode
- Slack HTTP mode through Bolt's Node receiver
- Telegram long polling
- Discord gateway
- webhook HTTP mode through Node's HTTP server
- local SQLite store

Not supported:

- multi-replica distributed delivery limiting
- crash-durable approval replay beyond persisted call and approval rows

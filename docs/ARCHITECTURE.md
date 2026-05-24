# Architecture

heypi is a thin Node.js wrapper around Pi for team chat agents. The library keeps the Pi agent loop behind a small app API and adds provider adapters, persistence, approvals, scheduling, sandboxed command/file tools, and runtime-backed workspace access.

## Goals

- Keep agent setup code-first and close to Pi conventions.
- Keep adapters provider-specific and the agent handler provider-neutral.
- Persist enough state for audit, retries, approvals, scheduling, and Pi session routing.
- Run commands and file tools inside one configured workspace runtime.
- Prefer explicit safety boundaries over model-only policy.

## Process Model

`createHeypi()` builds one long-running app process:

```text
createHeypi(config)
  store.setup()
  runtime = createRuntime(config.runtime)
  callRunner = new CallRunner(...)
  agent = new PiAgent(...)
  handler = createHandler(...)
  http = createHttpServerRegistry(...)
  adapters[].start({ handler, logger, attachments, http })
  http.listen()
  scheduler.start()
```

The current production runtime target is a hosted Node process. HTTP adapters register routes on heypi's shared Node HTTP listener, Slack Socket Mode uses a websocket connection, Telegram uses long polling, and Discord uses the gateway. Cloudflare Workers and other Fetch API runtimes are not supported yet.

## Main Boundaries

### App

`src/app.ts` is composition only. It wires the store, runtime, call runner, Pi agent, handler, adapters, attachments, and scheduler. It owns startup and shutdown sequencing, but does not contain provider, model, store, or tool behavior.

On `app.stop()`, heypi stops the scheduler and adapters, waits for active runs to drain, then cancels survivors after the configured drain timeout. The app-level lock prevents two processes with the same store from running the same agent at once.

### Config API

`src/config.ts` defines the public app configuration and the `agentFrom()` folder convention:

```text
agent/
  SOUL.md
  SYSTEM.md
  AGENTS.md
  skills/
  extensions/
```

`agentFrom()` resolves files and folders at process startup. Missing files are ignored, except `SOUL.md`: when it is absent, heypi uses a short built-in concise-assistant identity. The model must be passed explicitly or through `HEYPI_MODEL`.

Prompt layers are intentionally split:

- heypi runtime prompt: short built-in tool/protocol guidance, generated from active core tools.
- `SOUL.md`: identity, role, voice, and communication style. Missing `SOUL.md` falls back to the built-in concise identity.
- `AGENTS.md`: operating rules, domain/project instructions, and standing orders.
- `SYSTEM.md`: advanced full override of the heypi runtime prompt. Use it only when replacing the runtime prompt is intentional.

Programmatic `context` providers run once per turn and append compact dynamic system-prompt blocks before Pi builds the provider request. The handler also injects a small current-channel context block with provider, channel/thread ids or names when available, and sender id or name when available.

### Adapters

Adapters live under `src/io/` and translate provider events into provider-neutral `Inbound` messages. They also render outbound replies, approvals, progress, streaming updates, and attachments for their provider.

Slack, Telegram, and Discord share `runChatMessage()` for the normalized message path after a provider event has passed adapter-specific allow/trigger checks. The helper owns attachment loading, handler invocation, output placement dispatch, error logging, and progress cleanup. Platform lifecycle, buttons/callbacks, attachment transport, and error UX stay in each adapter.

Adapters that need inbound HTTP routes register them on the app's shared HTTP listener. All registered routes must use the same host and port; duplicate method/path pairs fail at startup.

The core adapter contract is:

```ts
type Adapter = {
	name: string;
	kind: string;
	start(input: AdapterStart): Promise<void>;
	send?(target: AdapterTarget, out: Outbound, input?: AdapterStart): Promise<void>;
	stop?(): Promise<void>;
};
```

`name` is the unique adapter instance identity and is stored as `provider` in durable thread/message/turn rows. `kind` is the adapter implementation type (`slack`, `webhook`, etc.) and is stored separately for filtering and diagnostics. Duplicate adapter names fail startup. HTTP adapters must share one host/port within an app, and duplicate `method + path` routes fail startup.

Inbound allowlists and channel membership are adapter concerns. Once an event is accepted, the shared handler owns turn creation, intent handling, locking, audit writes, and agent execution.

### Handler

`src/io/handler.ts` is the provider-neutral request path. It:

- normalizes text and attachments
- parses control intents such as approvals, approve, deny, status, and cancel
- creates or loads the thread
- de-duplicates provider events
- acquires a per-thread lock when the store supports locks
- applies same-thread busy behavior before starting a new turn
- starts the Pi turn or tool approval continuation
- writes audit, turn, call, and approval state
- returns redacted outbound text to the adapter

The handler is intentionally the only place where inbound provider messages become durable turns.

When a same-thread ask arrives while a turn holds the thread lock, the handler uses `concurrency.busy`. `steer` and `followUp` persist the inbound message as an audit row, add actor attribution, and enqueue it into the active Pi session through `ActiveRuns`. They do not create a second heypi turn. `reject` returns a public acknowledgement without calling Pi. If a pending approval exists, new asks are rejected until the approval is approved or denied; durable queueing across approvals is intentionally not implemented.

`ActiveRuns` stores the initiating actor and thread for each live run. Cancel requests only abort the run when they come from that initiating actor or a configured approver, and only from the same thread.

### Pi Runtime

`src/runtime/pi-agent.ts` adapts heypi threads to Pi `AgentSession`s. It opens the Pi session path stored on the thread route, registers heypi tools, exposes active-session `steer` and `followUp` hooks to the shared handler, subscribes to Pi events for logging and optional text streaming, and returns the assistant reply. Pi `SessionManager` is the canonical model transcript store; SQLite rows are not replayed as provider protocol history.

heypi does not expose Pi's raw tool runtime directly to users. It registers Pi-compatible tools backed by the configured heypi runtime and call runner.

### Tools And Approvals

`src/core/calls.ts` owns tool policy, approvals, and execution audit. Tool calls pass through:

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

Core tools and custom tools use the same confirmation path. `coreTools()` registers runtime-backed tools, and `commandConfirm()` adapts command classification into a normal `confirm` function for `bash` or command-shaped custom tools. Custom tools can use the exported `tool()` helper to require confirmation and replay after approval. Text commands and provider-native buttons both resolve to the same approval path. Adapters may acknowledge provider-native approval buttons immediately after authorization succeeds, then deliver the approved call result as a follow-up.

### Runtime

`src/runtime/` owns command and file access. Runtime selection is static per app:

- `just-bash`: default production runtime
- `docker-bash`: bash in Docker with the workspace mounted at `/workspace`
- `guarded-bash`: host bash plus regex guardrails
- `host-bash`: host bash, unsafe/dev/admin mode

File tools run under the configured workspace root and enforce size, lexical traversal, and symlink escape limits. `just-bash` network access is off by default; configure `runtime.justBash.network` when the agent needs `curl` or other network-backed commands. Regex command classification is a guardrail, not isolation. Use `just-bash` or `docker-bash` for team-facing agents.

### Store

`src/store/` defines the store interfaces and SQLite implementation. The store persists:

- thread routes with Pi `sessionId`/`sessionPath`
- message audit/search/status rows
- turns
- tool calls
- approvals
- jobs and job runs
- locks

Pi session history lives in JSONL files under the configured runtime root, for example `sessions/<session-id>.jsonl`. The per-thread lock gates writes to the corresponding Pi session file.

Thread routes store both `sessionId` and `sessionPath`. New routes use a random session id and a relative path under the runtime root; absolute session paths are resolved as-is by the Pi runtime adapter. SQLite is operational state and audit/search/status data only. It is not replayed as Pi protocol history.

The SQLite store supports local single-process deployments. Multi-instance deployments need a shared durable store with lock semantics. Custom stores should implement `transaction()` for atomic handler, call, and scheduler updates.

### Scheduler

`src/core/scheduler.ts` runs configured jobs:

- `cron`: scheduled proactive turns
- `heartbeat`: proactive turns over matching known chats, optionally gated by idle time

Scheduled turns reuse the same handler path as inbound messages with `scheduled: true`. Adapters that support scheduled outbound jobs must implement `send()`.

### Attachments

`src/io/attachments.ts` defines the attachment store and processing boundary. The default attachment store writes through the configured runtime workspace. Adapters download provider files into this store. Attachment processing passes supported images to Pi as image inputs, inlines text-like files, optionally converts document formats through a configured local converter, and falls back to attachment references for unsupported files or failed conversions.

### Delivery And Streaming

`src/io/delivery.ts` serializes provider sends and retries provider rate limits with backoff. It is per-adapter-instance pacing, not a distributed provider-wide limiter.

`src/io/reply-stream.ts` supports optional draft replies while Pi emits text deltas. Streaming is adapter-mediated and throttled to avoid editing on every token. Confirmed tool calls stop the draft before approval UI is sent; after approval, continuations can start a new draft stream.

When same-thread input was steered or queued into an active Pi session, adapters keep the original progress marker as a temporary anchor. At completion they delete that marker and post the final response as a new bottom-of-thread message, so users do not have to scroll back to find the answer.

## Request Flow

```text
Slack / Telegram / Discord event
  -> adapter allowlist + trigger check
  -> handler(Inbound)
  -> thread + message + turn persistence
  -> PiAgent.ask()
  -> Pi SessionManager + heypi tools
  -> CallRunner for tool policy and approvals
  -> runtime / approval / continuation
  -> audit persistence
  -> adapter sends Outbound
```

## Security Model

heypi's safety model is concrete and layered:

- provider allowlists decide which delivered events are accepted
- thread locks prevent overlapping turns in one conversation
- tool calls are audited
- dangerous bash commands can be blocked or approval-gated
- confirmed custom tools can require human approval
- file tools are scoped to the runtime workspace and size-limited
- `just-bash` is the safe default runtime
- `docker-bash` provides a stronger OS boundary for bash when Docker is available

The model does not claim that regex policies or host bash are isolation. `guarded-bash` and `host-bash` execute on the host and should be treated as unsafe/dev/admin modes.

## Deployment Boundaries

Supported today:

- long-running Node process
- Slack Socket Mode
- Slack HTTP mode through Bolt's Node receiver
- Telegram long polling
- Discord gateway
- Webhook HTTP mode through Node's HTTP server
- local SQLite store

Not supported today:

- Cloudflare Workers / Fetch API adapters
- multi-replica distributed delivery limiting
- crash-durable approval replay beyond persisted call and approval rows

These are intentionally documented as outside the shipped runtime until the adapter, store, scheduler, attachment, and deploy story is complete.

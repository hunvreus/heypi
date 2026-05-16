# Architecture

heypi is a thin Node.js wrapper around Pi for team chat agents. The library keeps the Pi agent loop behind a small app API and adds provider adapters, persistence, governed tools, approvals, scheduling, and runtime-backed workspace access.

## Goals

- Keep agent setup code-first and close to Pi conventions.
- Keep adapters provider-specific and the agent handler provider-neutral.
- Persist enough state for audit, retries, approvals, scheduling, and transcript replay.
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
  adapters[].start({ handler, logger, attachments })
  scheduler.start()
```

The current production runtime target is a hosted Node process. Slack HTTP mode uses Bolt's Node HTTP receiver, Slack Socket Mode uses a websocket connection, and Telegram uses long polling. Cloudflare Workers and other Fetch API runtimes are not supported yet.

## Main Boundaries

### App

`src/app.ts` is composition only. It wires the store, runtime, call runner, Pi agent, handler, adapters, attachments, and scheduler. It owns startup and shutdown sequencing, but does not contain provider, model, store, or tool behavior.

### Config API

`src/config.ts` defines the public app configuration and the `agentFrom()` folder convention:

```text
agent/
  SYSTEM.md
  AGENTS.md
  skills/
  extensions/
```

`agentFrom()` resolves files and folders at process startup. Missing files are ignored. The model must be passed explicitly or through `HEYPI_MODEL`.

### Adapters

Adapters live under `src/io/` and translate provider events into provider-neutral `Inbound` messages. They also render outbound replies, approvals, progress, streaming updates, and attachments for their provider.

The core adapter contract is:

```ts
type Adapter = {
	name?: string;
	start(input: AdapterStart): Promise<void>;
	send?(target: AdapterTarget, out: Outbound, input?: AdapterStart): Promise<void>;
	stop?(): Promise<void>;
};
```

Inbound allowlists and channel membership are adapter concerns. Once an event is accepted, the shared handler owns turn creation, intent handling, locking, transcript writes, and agent execution.

### Handler

`src/io/handler.ts` is the provider-neutral request path. It:

- normalizes text and attachments
- parses control intents such as approve, deny, status, and cancel
- creates or loads the thread
- de-duplicates provider events
- acquires a per-thread lock when the store supports locks
- starts the Pi turn or tool approval continuation
- writes transcript, turn, call, and approval state
- returns redacted outbound text to the adapter

The handler is intentionally the only place where inbound provider messages become durable turns.

### Pi Runtime

`src/runtime/pi-agent.ts` adapts heypi threads to Pi `AgentSession`s. It loads transcript history through the store session adapter, creates a Pi session, registers heypi tools, subscribes to Pi events for logging and optional text streaming, and returns the assistant reply plus generated messages for persistence.

heypi does not expose Pi's raw tool runtime directly to users. It registers Pi-compatible tools backed by the configured heypi runtime and call runner.

### Tools And Approvals

`src/core/calls.ts` owns governed tool execution. Tool calls pass through:

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

`bash` uses command policy. Custom tools can use the exported `tool()` helper to require confirmation and replay after approval. Text commands and provider-native buttons both resolve to the same approval path.

### Runtime

`src/runtime/` owns command and file access. Runtime selection is static per app:

- `just-bash`: default production runtime
- `guarded-bash`: host bash plus regex guardrails
- `host-bash`: host bash, unsafe/dev/admin mode

File tools run under the configured workspace root and enforce size and traversal limits. Regex command policy is a guardrail, not isolation. Use `just-bash` for team-facing agents.

### Store

`src/store/` defines the store interfaces and SQLite implementation. The store persists:

- threads and messages
- turns
- tool calls
- approvals
- jobs and job runs
- locks
- Pi session history

The SQLite store supports local single-process deployments. Multi-instance deployments need a shared durable store with lock semantics. Custom stores should implement `transaction()` for atomic handler, call, and scheduler updates.

### Scheduler

`src/core/scheduler.ts` runs configured jobs:

- `cron`: scheduled proactive turns
- `heartbeat`: proactive turns over matching known chats, optionally gated by idle time

Scheduled turns reuse the same handler path as inbound messages with `scheduled: true`. Adapters that support scheduled outbound jobs must implement `send()`.

### Attachments

`src/io/attachments.ts` defines the attachment store boundary. The default attachment store writes through the configured runtime workspace. Adapters download provider files into this store and add attachment references to the user prompt.

### Delivery And Streaming

`src/io/delivery.ts` serializes provider sends and retries provider rate limits with backoff. It is per-adapter-instance pacing, not a distributed provider-wide limiter.

`src/io/reply-stream.ts` supports optional draft replies while Pi emits text deltas. Streaming is adapter-mediated and throttled to avoid editing on every token. Confirmed tool calls stop the draft before approval UI is sent.

## Request Flow

```text
Slack / Telegram event
  -> adapter allowlist + trigger check
  -> handler(Inbound)
  -> thread + message + turn persistence
  -> PiAgent.ask()
  -> Pi session + heypi tools
  -> CallRunner for governed tools
  -> runtime / approval / continuation
  -> transcript persistence
  -> adapter sends Outbound
```

## Security Model

heypi's safety comes from layered runtime and governance boundaries:

- provider allowlists decide which delivered events are accepted
- thread locks prevent overlapping turns in one conversation
- tool calls are audited
- dangerous bash commands can be blocked or approval-gated
- confirmed custom tools can require human approval
- file tools are scoped to the runtime workspace and size-limited
- `just-bash` is the safe default runtime

The model does not claim that regex policies or host bash are isolation. `guarded-bash` and `host-bash` execute on the host and should be treated as unsafe/dev/admin modes.

## Deployment Boundaries

Supported today:

- long-running Node process
- Slack Socket Mode
- Slack HTTP mode through Bolt's Node receiver
- Telegram long polling
- local SQLite store

Not supported today:

- Cloudflare Workers / Fetch API adapters
- multi-replica distributed delivery limiting
- crash-durable approval replay beyond persisted call and approval rows
- serverless file bundle generation

These are intentionally documented as outside the shipped runtime until the adapter, store, scheduler, attachment, and deploy story is complete.

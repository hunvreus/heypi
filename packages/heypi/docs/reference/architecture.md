# Architecture

heypi is a coordination layer around Pi, not a replacement agent runtime.

## Responsibilities

Pi owns:

- model execution and provider authentication;
- session transcripts, compaction, and retries;
- the agent loop, core tools, extensions, and skill discovery.

heypi owns:

- agent-folder loading and resource staging;
- chat adapters and conversation routing;
- runtime selection and model-visible filesystem roots;
- approval policy and native approval interfaces;
- attachments, memory, todos, schedules, and small coordination records.

Keeping this boundary explicit avoids a second model loop and lets Pi features remain available
without reimplementation.

## Message flow

1. An adapter authenticates and normalizes an external event into a `ChatMessage`.
2. heypi applies access rules, deduplicates the message, and resolves its conversation and session.
3. Attachments and agent resources are staged into managed paths.
4. Pi receives the triggering message and runs the agent with runtime-backed tools.
5. heypi renders activity, todos, approvals, and the final response through the originating adapter.
6. Pi records its transcript while heypi records coordination and authorization events.

Only the triggering message is added automatically to the current Pi turn. Older messages remain
available through the `chat_history` tool so routine turns stay small and history access is
explicit.

## State and runtime paths

The default state directory is `.heypi`; change it with `state.dir`. Each adapter ID has an isolated
area containing shared files, chat-surface workspaces, Pi sessions, heypi audit records, memory, and
secret storage.

The model sees managed paths rather than host paths:

- `/workspace`: writable files for the active chat surface;
- `/shared`: optional writable files shared by the adapter's conversations;
- `/agent/skills`: staged skill instructions, scripts, and assets.

Sandboxed local runtimes mount skills read-only. Host and remote runtimes use disposable copies and
never synchronize changes into authored agent resources.

## Process and failure model

A heypi app is a long-running Node.js process. One app can run multiple adapters for one agent.
Adapters are started together and stopped in reverse order during shutdown.

Scheduling, queues, and active turns are coordinated inside one process. Run one active process for
a given state directory; heypi is not a distributed workflow engine.

Inbound messages are recorded before asynchronous processing. Stable message IDs make adapter
redelivery idempotent. Queued work and approval state can be recovered after restart, but arbitrary
in-flight model execution is not replayed. A process interruption leaves an audit record and the
next request resumes from Pi's persisted session state where applicable.

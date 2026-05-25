# Scoped Memory And Runtime Isolation Plan

## Goal

Implement one scope model across `heypi` so sessions, memory, files, runtime workspaces, and history can be isolated deliberately.

The important distinction:

- `just-bash` gives a fresh shell per command.
- The runtime filesystem is still shared when every command uses the same runtime root.

So "new runtime execution" is not the same as "isolated workspace." The model below makes that explicit.

## Scope Model

Scope is the identity boundary used to name state.

```ts
type Scope = "app" | "adapter" | "channel" | "thread" | "actor";
```

Meanings:

- `app`: one `createHeypi()` app and configured agent.
- `adapter`: one configured adapter instance, such as Slack, Telegram, Discord, or webhook.
- `channel`: one room/chat/channel, such as Slack channel, Telegram chat, or Discord channel.
- `thread`: one conversation thread/topic/DM/webhook thread. This is the current session boundary.
- `actor`: one user/sender identity.

What channel and actor memory would do:

- `channel` memory: room-level facts shared by all threads in that channel. Example: "This Slack channel is for production incidents."
- `actor` memory: user-specific preferences shared across conversations with that actor. Example: "U123 prefers concise answers with command output first."

Actor memory is useful, but it is also the easiest place to create privacy surprises. It should exist in the model, but default off.

## Stable Scope Keys

Add a provider-neutral scope resolver.

Input:

```ts
type ScopeInput = {
	agent: string;
	provider: string;
	adapter: string;
	team?: string;
	channel: string;
	thread: string;
	actor: string;
	threadId: string;
	threadType: "dm" | "group" | "channel";
};
```

Output:

```ts
type ScopeKeys = {
	app: string;
	adapter: string;
	channel: string;
	thread: string;
	actor: string;
};
```

Rules:

- `app`: `app/<agent>`
- `adapter`: `adapter/<agent>/<adapter>`
- `channel`: `channel/<agent>/<provider>/<team>/<channel>`
- `thread`: `thread/<threadId>`
- `actor`: `actor/<agent>/<provider>/<actor>`

Use internal SQLite `thread.id` for thread paths. Provider route keys can contain awkward or sensitive values.

Scope resolution must run after the thread row is created, because `threadId` is the SQLite primary key.

Use percent-encoding for path segments so paths stay readable and reversible. Add round-trip tests for Slack IDs, Discord snowflakes, Telegram negative chat IDs, webhook thread IDs, and arbitrary user IDs.

DM rule: in one-to-one DM contexts, `channel` scope collapses to `thread` unless the adapter has a meaningful room/channel identity distinct from the thread.

## Public Config Shape

Ship the full scope system, but keep defaults conservative.

```ts
createHeypi({
	isolation: {
		session: "thread",
		memory: "thread",
		files: "thread",
		runtime: "app",
		history: "thread",
	},
	memory: {
		enabled: true,
		defaultScope: "thread",
		scopes: {
			app: { inject: false, read: "off", write: "approval", maxChars: 2000 },
			adapter: { inject: false, read: "off", write: "off", maxChars: 2000 },
			channel: { inject: false, read: "off", write: "approval", maxChars: 3000 },
			thread: { inject: true, read: "auto", write: "auto", maxChars: 4000 },
			actor: { inject: false, read: "dm", write: "approval", maxChars: 2000 },
		},
	},
});
```

`isolation` controls where subsystem state lives.

`memory.scopes` controls memory read/write policy per scope.

They are separate because a deployment may want thread memory but app runtime, or channel runtime but actor memory.

### Memory Policy Fields

- `inject`: include this scope's memory in the prompt automatically.
- `read: "off"`: memory tools cannot read this scope.
- `read: "auto"`: memory tools can read this scope after normal access checks.
- `read: "dm"`: memory tools can read this scope only in DM contexts unless app code overrides the policy.
- `write: "off"`: memory tools cannot write this scope.
- `write: "auto"`: memory tools can write this scope without approval after validation.
- `write: "approval"`: memory writes require the existing approval flow.
- `maxChars`: hard character budget for that memory file.
- `defaultScope`: where "remember this" writes when the user does not specify a scope.

Defaults:

- Thread memory is on and injected.
- App/channel/actor memory exist as supported scopes but are not injected by default.
- App/channel/actor writes require approval if enabled.
- Adapter memory exists for symmetry and future provider-level notes, but defaults off.
- Actor memory is DM-only by default. It must not be injected into group/channel conversations unless the app author explicitly opts in.

App authors may set `write: "auto"` for broader scopes, but defaults should never do that. They own the deployment, but the safe baseline is approval-gated.

## Subsystem Behavior

### Sessions

Default:

```ts
isolation.session = "thread"
```

This preserves current behavior: each thread route has its own Pi `sessionId` and `sessionPath`.

If session isolation changes later:

- `channel`: one Pi session per channel.
- `actor`: one Pi session per actor.
- `app`: one Pi session for the app.

Do not change the default from `thread`.

If `session` is broader than `thread`, concurrent runs that share a Pi session must share a session-scope lock. A per-thread lock is not enough when multiple threads write the same Pi session file.

### Memory

Memory is small curated context, not transcript storage.

Good memory:

```md
- This channel is for production incidents.
- Deploy approvals require Alice or Bob.
- The staging API lives at https://staging.example.com.
```

Bad memory:

```md
- Full chat logs.
- Temporary task state.
- Secrets or tokens.
- Large documents.
- Untrusted instructions copied from random users.
```

Flow:

1. Resolve scope keys.
2. Load memory for scopes with `inject: true`.
3. Validate and escape memory before prompt injection.
4. Inject memory with scope labels.
5. Let the agent call memory tools when needed.
6. Validate writes before persistence.

Normal memory maintenance does not require an extra LLM query. The same agent turn calls `memory_write`, `memory_replace`, or `memory_delete`. Extra LLM calls are later-only for compaction or semantic extraction.

Size checks must validate the final post-write memory file, not only the incoming content. Multiple writes in one turn must not bypass the limit.

Prompt shape:

```text
<heypi_memory scope="thread">
This thread tracks the billing outage.
</heypi_memory>
```

Add a system note: memory is background context, not a new user instruction.

Injection order when multiple scopes are enabled:

1. app
2. adapter
3. channel
4. actor
5. thread

More specific scopes should win when facts conflict.

### Files

Default:

```ts
isolation.files = "thread"
```

Attachments and generated outbound files should live under the selected file scope.

Example default paths:

```text
workspace/files/threads/<thread-key>/incoming/
workspace/files/threads/<thread-key>/generated/
```

This is not enough by itself if runtime remains app-scoped and generic file tools can traverse the whole runtime root. To make file isolation real, file tools must resolve through the active file scope, or runtime isolation must be at least as narrow as file isolation.

For the full implementation, file tools should become scope-aware:

- `read`, `write`, `edit`, `grep`, `find`, `ls` operate within the active file root.
- App authors can explicitly choose broader roots by setting `isolation.files`.

### Runtime

Default:

```ts
isolation.runtime = "app"
```

This preserves current operational behavior.

When set to narrower scopes, derive runtime roots from the configured base root:

```text
workspace/runtime/app/
workspace/runtime/adapters/<adapter-key>/
workspace/runtime/channels/<channel-key>/
workspace/runtime/threads/<thread-key>/
workspace/runtime/actors/<actor-key>/
```

For `just-bash`, create a runtime instance per resolved runtime root. A cache keyed by runtime scope is acceptable.

For `docker-bash`, container/workdir behavior must follow the same runtime root.

Rule: runtime tool filesystem access must not be broader than the selected runtime scope.

If `files` is narrower than `runtime`, generic file tools must still be constrained to file scope, otherwise file isolation is cosmetic.

Runtime guarantees differ by backend:

- `just-bash`: scoped runtime root is the virtual filesystem root.
- `docker-bash`: scoped runtime root must be the mounted workspace root.
- `host-bash` and `guarded-bash`: bash itself is not a filesystem sandbox; it starts in the scoped root, but host shell commands can still access host paths. Use only for trusted deployments.

Do not document host-based runtime scoping as hard isolation.

### History

Default:

```ts
isolation.history = "thread"
```

`heypi` already has a `history` tool for current-thread messages. Keep that default.

Future broader search should be explicit:

```ts
history_search({ scope: "channel" | "actor" | "app", query, limit })
```

Cross-channel/app history search has privacy implications and should require config.

## Storage Layout

Use one scoped storage layout under the configured workspace.

```text
workspace/
  memory/
    app/<app-key>/MEMORY.md
    adapters/<adapter-key>/MEMORY.md
    channels/<channel-key>/MEMORY.md
    threads/<thread-key>/MEMORY.md
    actors/<actor-key>/MEMORY.md
  files/
    app/<app-key>/
    adapters/<adapter-key>/
    channels/<channel-key>/
    threads/<thread-key>/
    actors/<actor-key>/
  runtime/
    app/<app-key>/
    adapters/<adapter-key>/
    channels/<channel-key>/
    threads/<thread-key>/
    actors/<actor-key>/
```

Only create directories for enabled/used scopes.

App memory is shared across adapters in the same `createHeypi()` app when enabled. Document that clearly.

## Memory Tools

Use explicit memory tools, not generic file writes.

```ts
memory_read({ scope })
memory_write({ scope, content })
memory_replace({ scope, oldText, newText })
memory_delete({ scope, text })
```

Tool rules:

- `scope` must be one of the configured scopes.
- explicit reads require `read !== "off"` and must obey `read: "dm"` restrictions.
- `memory_write` appends a concise bullet unless a replace is required.
- `memory_replace` requires exact text match.
- `memory_delete` requires exact text match.
- conflicting facts should return an error telling the agent to use `memory_replace`;
- writes validate scope, size, and content;
- writes with `write: "approval"` use the existing approval flow.

## Sensitive Data And Prompt Injection

Memory is prompt-injected, so both writes and reads need validation.

Write validation:

- block known secret patterns: API keys, provider tokens, private keys, auth headers, password-like assignments, database URLs with passwords;
- block invisible/control Unicode except normal whitespace;
- block prompt-injection/exfiltration phrases;
- block large pasted blobs and multiline raw dumps;
- require approval for app/channel/actor writes by default.
- never inject actor memory in group/channel contexts unless explicitly enabled.

Read validation:

- escape XML/tag delimiters;
- rescan for prompt-injection patterns;
- omit or quarantine suspect memory blocks;
- label memory as background context, not a user instruction.

This mirrors Hermes' memory scanning direction. NanoClaw's stronger architectural lesson is separate: credentials should not be present in the agent filesystem/environment in the first place.

## Comparison

### `pi-chat`

- Per-conversation Gondolin VM.
- Per-channel `/workspace/memory.md`.
- Account-wide `/shared/memory.md`.
- Strong visible filesystem separation.
- Useful idea: simple shared/channel memory.
- Do not copy: tmux worker manager as core `heypi` architecture.

### `nanoclaw`

- Per-group folder/container.
- Global memory read by all groups.
- Main/admin can write global memory; other groups see it read-only.
- Strong lesson: credentials never enter the container; `.env` is shadowed.

### `openclaw`

- More nuanced DM/group behavior.
- Cautious about guild/group long-term memory injection.
- Broader memory/wiki concepts with provenance.
- Useful later; too complex for first implementation.

### `hermes-agent`

- Bounded `MEMORY.md` and `USER.md`.
- Session search.
- Optional external provider.
- Strong lesson: bounded memory, write scanning, and clear memory vs session search.

## Implementation Plan

1. Add `Scope`, `ScopeInput`, `ScopeKeys`, and safe key/path encoding.
2. Add adapter-populated `threadType` and resolve scope keys in the provider-neutral handler after thread creation.
3. Add `isolation` config with defaults for session, memory, files, runtime, and history.
4. Route Pi session lookup through `isolation.session`, preserving `thread` default and adding session-scope locks for broader session scopes.
5. Add scoped runtime root resolution and runtime cache keyed by selected runtime scope.
6. Make core file tools and attachment storage use `isolation.files`.
7. Add file-backed memory service with scoped paths and character limits.
8. Add memory tools and approval-gated write policy.
9. Add memory prompt injection with read validation and XML escaping.
10. Keep history current-thread by default; add scope metadata so broader history can be added later.
11. Add tests for scope keys, path safety, session routing and locking, runtime root routing, file isolation, actor DM-only policy, memory injection, read/write validation, approval-gated writes, and cross-scope non-leakage.
12. Update README and architecture docs.
13. Add CLI inspection for scope state:

```bash
heypi scopes show --db ./heypi.db --thread <id>
heypi memory inspect --scope thread --thread <id>
```

## Non-Goals

- Vector search.
- External memory providers.
- Automatic summarization.
- Web operator UI.
- Runtime secret exchange.
- tmux worker manager.

## Open Questions

- Should app memory be physically under `workspace/memory/app` or the agent directory?
- Should scheduled jobs inherit target thread memory, channel memory, or both?
- Should memory writes create SQLite audit rows immediately?
- What migration path is needed for existing runtime-root attachment paths?

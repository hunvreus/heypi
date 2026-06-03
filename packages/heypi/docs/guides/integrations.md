# Custom integrations

Custom integrations are trusted TypeScript code that changes how heypi connects to the outside world. They are not agent-callable tools. For commands the model can call during a turn, use [Agent tools](../configuration/tools.md).

Use a custom integration when the built-in adapters, runtime providers, attachment store, or SQLite store do not fit your deployment.

## Adapter

Use a custom adapter for a new event source: another chat platform, an internal queue, email, or a product-specific webhook.

```ts
import type { Adapter } from "@hunvreus/heypi/adapter";

export const adapter: Adapter = {
	name: "internal",
	kind: "internal",
	async start({ handler }) {
		// Translate provider events into handler.message(...)
	},
	async send(target, output) {
		// Send replies, approvals, progress, or attachments back.
	},
	async stop() {
		// Close sockets, pollers, or HTTP clients.
	},
};
```

Pass adapters to `createHeypi({ adapters: [...] })`. The adapter owns provider auth, event normalization, delivery, and provider-specific IDs. heypi owns turns, approvals, runtime execution, scheduling, and state.

## Runtime provider

Use a custom runtime provider for a new execution backend: a VM manager, remote container service, Cloudflare Sandbox, E2B, Daytona, or an internal runner.

```ts
import type { RuntimeProvider } from "@hunvreus/heypi/runtime";

export const provider: RuntimeProvider = {
	get(scope) {
		return {
			name: "internal-runtime",
			root: scope.path,
			async bash(input) {
				// Execute inside the scoped backend.
			},
		};
	},
	async stop(scope) {
		// Stop one scoped backend, or all when scope is omitted.
	},
};
```

Configure it with [`runtime.provider`](../configuration/runtime.md). Providers receive a scoped root and may keep a container, VM, or remote workspace warm per scope. Core tools and `ctx.runtime` use the same provider.

## Attachment store

Use a custom attachment store when files need to live outside the runtime workspace, usually for shared storage, object storage, or multi-instance deployments.

```ts
import type { AttachmentStore } from "@hunvreus/heypi/attachments";

export const attachments: AttachmentStore = {
	maxBytes: 25_000_000,
	async save(input) {
		// Store inbound provider bytes and return an Attachment.
	},
	async resolve(input, scope) {
		// Resolve an outbound attachment for upload.
	},
};
```

Attachment stores receive the current scope on save and resolve. They must preserve scope boundaries; a file from one scope should not be resolvable from another.

## Store

Use a custom store when SQLite is not enough, especially for multi-instance deployments.

```ts
import type { Store } from "@hunvreus/heypi/store";

export const store: Store = {
	threads,
	messages,
	turns,
	calls,
	approvals,
	locks,
	async setup() {},
	async transaction(fn) {
		// Run related writes atomically.
	},
};
```

The store persists operational state: threads, messages, turns, calls, approvals, jobs, job runs, and locks. If scheduling is enabled, provide `jobs`, `jobRuns`, and `locks`. For multi-instance deployments, locks must be durable and shared.

## Pi extensions

Pi extensions are trusted in-process code loaded from explicit `agent.extensions` paths or `agent/extensions/`.

heypi disables Pi's default/global extension discovery. Configure each chat agent's extension set directly.

Use extensions for Pi-native behavior that belongs below heypi. Use heypi tools or adapters when the behavior needs heypi approvals, scopes, runtime context, or provider delivery.

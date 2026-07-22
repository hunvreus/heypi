# Deployment

Deploy heypi as a supervised, long-running Node.js process with persistent state. The core package
requires Node.js 22 or later; Gondolin requires Node.js 23.6 or later and QEMU.

## Production checklist

1. Build and start the app with one process for its state directory.
2. Persist `.heypi` and every explicitly configured workspace.
3. Supply model and adapter credentials through the trusted process environment.
4. Select an explicit runtime; do not accept the host-execution warning accidentally.
5. Restrict adapters with `allow` and configure explicit approvers for sensitive tools.
6. Protect non-loopback webhook and admin listeners with secrets or tokens.
7. Supervise restarts and forward structured logs to your logging system.
8. Back up Pi transcripts, heypi records, workspaces, memory, and secret keys together.

## Process lifecycle

`runHeypi()` starts the app and installs normal signal handling through the application lifecycle.
Call `app.stop()` in embedded environments. Shutdown stops intake, cancels or settles active work,
flushes coordination state, stops adapters, and cleans up runtime resources.

heypi recovers durable queued work and records interrupted turns, but it does not replay arbitrary
in-flight model execution. Use platform-stable message IDs so redelivery remains idempotent.

## Network surfaces

Slack uses outbound Socket Mode, Discord uses the outbound Gateway, and Telegram uses outbound long
polling. Webhook and admin adapters bind local HTTP listeners.

Terminate public TLS in a reverse proxy or platform ingress. A non-loopback webhook requires HMAC
authentication. A non-loopback admin server requires a token; wildcard binds also require a Host
allowlist.

## Runtime requirements

Docker execution requires a running Docker daemon and a bind-mountable workspace. The selected image
must include `/bin/bash`. Gondolin requires QEMU. Vercel and Cloudflare require their provider SDK
credentials and infrastructure. Runtime environment values are model-visible and are not a
credential broker.

See [Runtimes](../configuration/runtimes.md), [Agent configuration](../configuration/agent.md), and
[Admin and audit](../configuration/admin.md).

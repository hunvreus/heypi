# HTTP listener

`http` configures heypi's public Node HTTP listener for adapter routes and self-hosted secret pages.

## Config

```ts
createHeypi({
  http: { host: "127.0.0.1", port: 0 },
  // ...state, adapters, agent, runtime
});
```

## Options

| Option | Required | Default | Description |
| --- | --- | --- | --- |
| `host` | No | `"127.0.0.1"` | Host passed to Node's HTTP server. |
| `port` | No | `3000` | Port passed to Node's HTTP server. Use `0` to ask the OS for any free port. |

## Routes

heypi starts the public HTTP server only when a feature registers routes:

- [Slack HTTP mode](../adapters/slack.md): `/slack/{name}/events`
- [Webhook](../adapters/webhook.md): `/webhook/{name}`
- [Self-hosted secrets](secrets.md#self-hosting): `/secret` or the path from `secrets.url`

[Admin](admin.md) and `heypi dev` local test routes use the private admin listener configured by `admin.http`.

Socket-mode Slack, Discord, and Telegram polling do not use the public HTTP server unless webhook or secrets self-hosting is also configured.

## Notes

- Public adapter routes share the top-level `http` host and port.
- Admin and dev routes use `admin.http`, which defaults to `127.0.0.1:4321`.
- Duplicate or structurally conflicting routes are rejected.
- `port: 0` is useful for Socket Mode, Discord, Telegram polling, and local admin. heypi logs the actual bound port at startup.
- Provider callbacks such as Slack HTTP mode, Telegram webhook mode, and generic webhook callers usually need a stable externally reachable URL, so pin the port there.
- Self-hosted secret pages need `secrets.url` to match the public URL users open. If you use `port: 0`, prefer the hosted secret page or set a fixed port for local self-hosting.
- Non-loopback listeners (`host: "0.0.0.0"`) should sit behind a reverse proxy with TLS and access controls.

# HTTP listener

`http` configures heypi's shared Node HTTP listener.

## Config

```ts
createHeypi({
	http: { host: "127.0.0.1", port: 3000 },
	// ...state, adapters, agent, runtime
});
```

## Options

| Option | Required | Default | Description |
| --- | --- | --- | --- |
| `host` | No | `"127.0.0.1"` | Host passed to Node's HTTP server. |
| `port` | No | `3000` | Port passed to Node's HTTP server. |

## Routes

heypi starts the HTTP server only when a feature registers routes:

- [Admin](admin.md): `/admin/*`
- [Slack HTTP mode](../adapters/slack.md): `/slack/{name}/events`
- [Webhook](../adapters/webhook.md): `/webhook/{name}`
- [Self-hosted secrets](secrets.md#self-hosting): `/secret` or the path from `secrets.url`

Socket-mode Slack, Discord, and Telegram polling do not use the HTTP server unless admin, webhook, or secrets self-hosting is also configured.

## Notes

- All HTTP routes in one app share the same host and port.
- Duplicate or structurally conflicting routes are rejected.
- Non-loopback listeners (`host: "0.0.0.0"`) should sit behind a reverse proxy with TLS and access controls.

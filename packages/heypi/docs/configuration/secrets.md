# Secrets

Secret requests let the agent ask for credentials without putting plaintext secrets in chat or model context.

## Config

```ts
createHeypi({
	state: { root: "./state" },
	// ...adapters, agent, runtime
	secrets: true,
});
```

## Options

| Option | Required | Default | Description |
| --- | --- | --- | --- |
| `enabled` | No | `false` | Enables the `secret_request` managed tool. |
| `url` | No | `https://heypi.dev/secret` | Public page URL sent to users. |
| `serve` | No | `false` | Serves the static secret page from this heypi app. |
| `expiresInMs` | No | `600_000` | Pending request lifetime. |
| `maxFields` | No | `8` | Maximum fields per request. |

When enabled, heypi exposes `secret_request`. The agent passes a reason and one or more fields:

```ts
{
	reason: "Need a GitHub token to inspect private workflow logs.",
	fields: [
		{ name: "GITHUB_TOKEN", label: "GitHub token" },
		{ name: "GITHUB_OWNER" },
	],
}
```

heypi returns a browser link. The user opens it, enters the values, encrypts them locally, and pastes the `heypi-secret:...` blob back into the same chat scope. heypi decrypts locally and writes the values into the active runtime workspace:

```text
.secrets/GITHUB_TOKEN
.secrets/GITHUB_OWNER
```

The encrypted blob is intercepted before the normal model turn, so it is not stored as chat history and is not sent to the model.

## Self hosting

The default page URL is:

```text
https://heypi.dev/secret
```

That page is static client-side code. It receives the public key and request metadata in the URL fragment, encrypts locally with WebCrypto, and does not need server-side access to your heypi instance. It uses generated Basecoat CSS and no JavaScript UI widgets.

To self-host the page from your own heypi app:

```ts
createHeypi({
	state: { root: "./state" },
	// ...adapters, agent, runtime
	http: { host: "0.0.0.0", port: 3000 },
	secrets: {
		url: "https://203-0-113-10.sslip.io/secret",
		serve: true,
	},
});
```

`secrets.url` is the public URL placed in chat. With `serve: true`, heypi serves the static page at that URL's path. It also serves the stylesheet at `<path>.css`. Use HTTPS for real secrets.

## Security model

- The private key stays in the heypi process memory and expires with the request.
- Secret values are stored as scoped runtime files, not memory.
- Anyone who can read the scoped runtime workspace can read saved secrets.
- Pending secret requests are lost on process restart.
- Field `name` is the stable file/env-style key; `label` is optional display text.

Use narrow runtime scope and runtime isolation for sensitive credentials.

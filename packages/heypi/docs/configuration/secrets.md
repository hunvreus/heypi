# Secrets

The `chat_request_secret` tool collects a credential from the active user without exposing the raw
value to the model or chat transcript.

## Flow

1. heypi creates a pending request and public key.
2. The user opens the local admin secret page or hosted static secret page.
3. The browser encrypts the value before submission.
4. heypi decrypts it in the trusted process and stores it encrypted at rest under `.heypi`.

The encrypted reply can be submitted to `/admin/secret` or pasted into chat as
`!secret:<id>:<payload>`. Secret replies are intercepted before Pi sees them. The raw secret is not
written into `/workspace` and is not returned in the tool result.

The state root contains both encrypted values and `secrets.key`. Protect and back up that key with
the state it decrypts. Filesystem permissions and host access remain the operator's responsibility.

## Using collected credentials

Secret collection and credential use are separate concerns. Model-driven runtime commands do not
receive collected secrets automatically. Expose credentials only through trusted-side tools,
connections, or a runtime-specific credential broker.

Runtime `env` is model-visible and can be printed by Bash. Do not treat it as a secret store.

For a remote secret page, configure a trusted HTTPS page that performs the same browser-side
encryption. Never ask users to paste plaintext credentials into Slack, Discord, or Telegram.

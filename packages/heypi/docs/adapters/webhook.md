# Webhook

The webhook adapter accepts normalized messages over HTTP and returns after durable intake. It is an
ingress adapter; outbound messages are retained in its in-process `sent` collection for the
embedding application to deliver or inspect.

```ts
import { webhook } from "@hunvreus/heypi";

const chat = webhook({
	id: "automation",
	host: "127.0.0.1",
	port: 4321,
	path: "/webhook",
	secret: process.env.HEYPI_WEBHOOK_SECRET,
});
```

Non-loopback hosts require `secret`. Request bodies are limited to 1 MB.

## Request

```json
{
  "id": "request-123",
  "text": "Summarize the latest report",
  "conversation": "reports",
  "user": { "id": "service", "name": "Reporting service" }
}
```

`id` is required, non-empty, and stable across transport retries. Reusing it prevents duplicate
processing. Optional fields include `channel`, `session`, `thread`, `replyTo`, `mentioned`, `dm`,
`time`, and `attachments`. `user.id` identifies the caller for access and approval policy.

## Authentication

Send Unix time in `X-Heypi-Timestamp` and:

```text
X-Heypi-Signature: sha256=<hmac_sha256(secret, timestamp + "." + rawBody)>
```

The default timestamp tolerance is five minutes and can be changed with `signatureToleranceMs`.
Successful intake returns `202`; model processing continues asynchronously.

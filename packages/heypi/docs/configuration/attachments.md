# Attachments

Slack, Discord, and Telegram can materialize inbound files into the active conversation workspace
and upload generated files in replies.

## Inbound files

Files are downloaded before Pi receives the message and stored under:

```text
/workspace/attachments/{messageId}/...
```

Pi receives the managed runtime path rather than a temporary platform URL. A failed attachment batch
removes partial files and fails the message before model execution.

Configure limits per adapter:

```ts
slack({
	token,
	appToken,
	attachments: {
		maxBytes: 20 * 1024 * 1024,
		timeoutMs: 30_000,
		mimeTypes: ["image/*", "application/pdf", "text/plain"],
		retry: { attempts: 3 },
	},
});
```

Built-in adapters restrict downloads to platform file hosts. Setting `hosts` replaces that
allowlist, including redirect destinations. Keep the list narrow.

## Outbound files

Pi sends generated files through `chat_attach`:

```text
chat_attach({ paths: ["reports/summary.pdf"], text: "Report ready." })
```

Paths must remain under `/workspace` or `/shared`. Built-in chat adapters upload local files when
their APIs support it; other adapters return path or link references in text.

Remote runtimes synchronize generated files back before attachment delivery. Custom runtimes must
provide equivalent consistency if shell commands can create files outside the runtime file API.

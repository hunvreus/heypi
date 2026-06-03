# Attachments

Attachments let the agent receive user files and send generated runtime files back to chat.

## Config

```ts
createHeypi({
	attachments: {
		maxBytes: 25_000_000,
		process: { documents: true },
	},
	// ...state, adapters, agent, runtime
});
```

## Options

| Option | Required | Default | Description |
| --- | --- | --- | --- |
| `store` | No | Runtime-backed store | Custom `AttachmentStore`. |
| `maxBytes` | No | `25_000_000` | Maximum inbound or outbound attachment size. |
| `process.documents` | No | Off | Convert supported document attachments to text for the model. |

## Inbound files

Supported adapters save delivered files into the runtime workspace under the active scope. Images can be passed to the model as image inputs. Text-like files are inlined. Unsupported binaries are stored but not passed to the model.

Provider support differs. See [Adapters](../adapters/index.md).

## Document conversion

Enable document conversion when the model should inspect PDFs, Office files, or similar documents.

```ts
createHeypi({
	attachments: {
		process: {
			documents: {
				timeoutMs: 15_000,
				maxOutputBytes: 1_000_000,
			},
		},
	},
	// ...state, adapters, agent, runtime
});
```

The default converter, `heypi-convert-document`, uses [Microsoft MarkItDown](https://github.com/microsoft/markitdown) to convert supported files to Markdown.

Requirements:

- Python 3.
- `uv`, or MarkItDown installed in the current Python environment.

With `uv`, the converter can run MarkItDown on demand:

```bash
npx heypi-convert-document --setup
```

Without `uv`, install MarkItDown yourself:

```bash
python3 -m pip install "markitdown[pdf,docx,pptx,xlsx]"
```

Default converted extensions are `.pdf`, `.doc`, `.docx`, `.ppt`, `.pptx`, `.xls`, `.xlsx`, and `.epub`.

Converter options:

| Option | Required | Default | Description |
| --- | --- | --- | --- |
| `command` | No | `HEYPI_DOCUMENT_CONVERTER` or `heypi-convert-document` | Converter executable. |
| `args` | No | `[]` | Extra args before the file path. |
| `env` | No | `{ PATH }` | Environment passed to the converter. |
| `timeoutMs` | No | `15_000` | Conversion timeout. |
| `maxBytes` | No | No attachment-specific cap | Maximum input size for conversion. |
| `maxOutputBytes` | No | `1_000_000` | Maximum Markdown output size. |
| `extensions` | No | Built-in document extensions | File extensions to convert. |
| `mimeTypes` | No | `[]` | Extra MIME types to convert. |

## Outbound files

The `attach` core tool marks a runtime file for upload with the final reply. Files must stay inside the active runtime scope.

```ts
agentFrom("./agent", {
	tools: [...coreTools({ attach: true })],
});
```

## Scope

Attachments are scoped to the active runtime workspace. Files from another scope are rejected, including outbound files queued with the `attach` tool.

## Custom stores

The default store is runtime-backed. Use a custom `AttachmentStore` when files need to live outside the runtime workspace, usually for multi-instance deployments.

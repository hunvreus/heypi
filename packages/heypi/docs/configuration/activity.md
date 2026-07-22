# Conversation behavior

Adapters use native platform activity instead of posting and deleting progress messages.

## Activity

- Slack sets native assistant status to `Thinking...`, switches to `Working...` on the first tool,
  and clears status on completion, cancellation, failure, or approval pause.
- Discord and Telegram refresh native typing while a turn is active.
- Slack adds an `eyes` reaction to accepted app mentions before attachment staging.
- Todo progress is a separate editable adapter message when todo support is enabled.

```ts
slack({ token, appToken, status: true, reaction: "eyes" });
discord({ token, typing: true });
telegram({ token, typing: true });
```

Set `status`, `typing`, or `reaction` to `false` to disable that surface.

## Busy conversations

`busy` controls a follow-up received during an active turn:

- `queue` is durable FIFO and is the default;
- `steer` calls Pi's active `session.steer()`;
- `reject` creates no turn.

Messages with attachments are queued even in steer mode so files can be staged safely.

## Event overrides

Adapters expose normalized lifecycle events through `events`. A custom handler replaces the
platform default; `false` disables it.

```ts
slack({
	token,
	appToken,
	events: {
		tool_started: false,
		message_queued: async (_event, { send, message }) => {
			await send({ conversation: message.conversation, text: "Queued." });
		},
	},
});
```

See [API](../reference/index.md) for the stable event list.

# Architecture

heypi is a Pi-native chat adapter shell.

```text
Slack / Discord / Telegram / webhook
  -> adapter event
  -> conversation runtime
  -> Pi session runtime
  -> Pi events
  -> adapter renderer
```

## Ownership

Pi owns:

- model execution
- transcript
- compaction
- retries
- built-in tools
- custom tools through extensions
- extension state
- session state

heypi owns:

- `loadAgent()` folder discovery
- staging authored files into Pi-visible paths
- chat adapter ingress/egress
- conversation job queueing
- product renderers for approvals/todos/admin later

## Resource loading

The app author writes:

```text
agent/
  config.json
  instructions.md
  system.md
  skills/
  tools/
  extensions/
```

heypi copies that tree into `.heypi/agents/<agent>/agent`. Pi then discovers skills and extensions
from that staged agent directory. `agent/tools/*.ts|*.js` is passed to Pi as extension paths.

Host source paths are not put into the model prompt.

`config.json` is data-only. Runtime values such as models and adapters stay in code and are passed
to `loadAgent()`.

## Conversation context

heypi stores a small conversation log for adapter coordination. A Pi job receives either the
triggering chat message or the small delta since the last completed trigger. Older chat is available
through the Pi `chat_history` tool, so history is retrieved intentionally instead of injected
passively into every prompt.

Pi can send sparse chat updates through `chat_reply`. heypi only renders the adapter side effect;
the model decides when the update is useful.

## Future features

Memory and todo/planning should be Pi extensions with heypi renderers. They should not be
implemented as heypi-owned prompt machinery or a second model loop.

Approval policy is already hooked through Pi `tool_call` events. Slack has a built-in approval
message with buttons. Other adapter factories expose `onApproval(view)` until their built-in UI is
implemented.

# Adapters

Adapters authenticate platform events, normalize them into `ChatMessage`, and render replies,
activity, approvals, todos, and attachments through native APIs.

| Adapter | Transport | Default trigger | Continuation |
| --- | --- | --- | --- |
| [Slack](slack.md) | Socket Mode | DMs and app mentions | Native thread |
| [Discord](discord.md) | Gateway | DMs, mentions, and replies | Reply chain |
| [Telegram](telegram.md) | Long polling | Private chat, mentions, and replies | Reply chain or forum topic |
| [Webhook](webhook.md) | HTTP | Every accepted request | Supplied session/thread IDs |
| [Local](local.md) | In-process | Every received message | Supplied IDs |

Bot self-messages never trigger a turn. Other bots are denied unless enabled by `allow.bots`.

## Shared configuration

- `id`: stable storage and routing identity;
- `allow`: DM, channel, user, group, and bot filters;
- `admins`: actors with administrative and approval privileges;
- `approvers`: additional actors who may answer approvals;
- `approvals`: native layout and timeout;
- `busy`: queue, steer, or reject follow-ups during active work;
- `events`: replace or disable normalized lifecycle handlers.

See [Access control](../configuration/access.md), [Approvals](../configuration/approvals.md), and
[Conversation behavior](../configuration/activity.md) for shared semantics.

Use stable adapter IDs. Changing an ID creates a new storage, memory, workspace, and conversation
namespace.

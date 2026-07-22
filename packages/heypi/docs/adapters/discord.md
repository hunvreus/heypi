# Discord

The Discord adapter uses the Gateway and responds to direct messages, bot mentions in configured
server channels, and replies that continue an existing agent conversation.

```ts
import { discord } from "@hunvreus/heypi";

const chat = discord({
	id: "company-discord",
	token: process.env.DISCORD_TOKEN!,
	clientId: process.env.DISCORD_CLIENT_ID,
	allow: { channels: ["123456789012345678"] },
	typing: true,
});
```

`clientId` is optional at runtime but used by setup helpers.

## Set up the app

```sh
heypi discord env-example
heypi discord check
heypi discord guilds
heypi discord channels --guild 123456789012345678
heypi discord invite
```

Enable the intents reported by `heypi discord check`, including message content where required by
Discord.

## Conversations

Every DM belongs to one persistent Pi session. A top-level server mention starts a new session.
heypi replies to that message, and replies to the agent continue the same session as a reply chain.

Discord native threads are delivery containers. Their parent channel controls access; each new
top-level mention inside the thread starts a separate session.

## Activity, approvals, and files

Discord refreshes native typing while work is active. Set `typing: false` to disable it. Approval
requests use buttons and may render as compact messages or embeds. `approvers.roles` accepts Discord
role IDs.

Inbound attachments are downloaded from Discord's file hosts under the configured policy. Generated
files are uploaded with the final or explicit attachment response.

# Manual channel QA

This folder is only a manual smoke checklist. It does not define a QA app, env file, or automation runner.

Use the existing examples as the runnable apps:

```sh
(cd examples/slack-devops && pnpm dev)
(cd examples/discord-gondolin && pnpm dev)
(cd examples/telegram-workout && pnpm dev)
(cd examples/webhook-github-docker && pnpm dev)
```

Slack and Discord examples use an OS-assigned local admin port by default. Webhook examples keep a fixed port because provider callbacks and curl smoke requests need a stable URL.

## Common checks

For every chat adapter, verify:

1. The bot starts without startup errors.
2. The bot only responds in the configured channel/chat/user scope.
3. A basic prompt gets a normal reply.
4. `/status` or the platform-native status command works.
5. A generated file is actually uploaded or the bot reports upload failure.
6. An approval-gated action shows an approval request.
7. Approve and deny controls work.
8. Admin-only controls work for a configured admin.
9. The admin panel shows the thread, run, calls, and approval state.

Admin login links:

```sh
pnpm exec heypi admin link
```

Run the admin command from the example folder whose app is running.

## Slack

### Setup

1. Create or update a Slack app from a generated manifest:

   ```sh
   pnpm exec heypi slack manifest --mode socket --command /heypi > /tmp/heypi-slack.yaml
   ```

2. In Slack app settings, create an app-level token with `connections:write`.
3. Install the app to the workspace.
4. Invite the bot to the test channel.
5. Configure the example:

   ```sh
   cd examples/slack-devops
   cp .env.example .env
   ```

6. Fill:

   ```env
   # Required
   SLACK_BOT_TOKEN=xoxb-...
   SLACK_APP_TOKEN=xapp-...
   OPENAI_API_KEY=...

   # Optional, useful for allowlist and approval QA
   HEYPI_SLACK_CHANNELS=C...
   HEYPI_SLACK_USERS=U...
   HEYPI_SLACK_GROUPS=S...
   HEYPI_SLACK_APPROVERS=U...
   HEYPI_SLACK_APPROVER_GROUPS=S...
   HEYPI_SLACK_ADMINS=U...
   HEYPI_SLACK_ADMIN_GROUPS=S...
   HEYPI_SLACK_JOB_CHANNEL=C...
   ```

### Preflight

```sh
pnpm exec heypi slack check --mode socket
pnpm exec heypi slack channels <channel-name-or-id>
pnpm exec heypi slack users <user-name-or-id>
```

### Run

```sh
pnpm dev
```

### Smoke prompts

In the configured Slack channel:

```text
@heypi help
@heypi create smoke.txt with "hello from slack" and attach it
@heypi run echo hello from slack
/heypi status
/heypi approvals
/heypi bypasses
/heypi bash echo hello from slack
```

If approval is requested, approve with the button and then retry with:

```text
/heypi approve <approval-id>
/heypi deny <approval-id>
```

Expected result: replies stay in the same thread, generated files upload, failed uploads are visible, approvals resume or deny the pending action, and configured admins can inspect broader approval/bypass state.

## Discord

### Setup

1. Create a Discord application and bot.
2. Enable Message Content Intent.
3. Invite the bot with:

   ```sh
   pnpm exec heypi discord invite --client-id <application-id>
   ```

4. Grant the bot channel permissions:
   - View Channel
   - Send Messages
   - Send Messages in Threads
   - Read Message History
   - Add Reactions
   - Attach Files

   Slash commands require the `applications.commands` OAuth scope from the generated invite URL. Users also need Discord's `Use Application Commands` permission in the channel.
5. Configure the example:

   ```sh
   cd examples/discord-gondolin
   cp .env.example .env
   ```

6. Fill:

   ```env
   DISCORD_BOT_TOKEN=...
   DISCORD_CLIENT_ID=...
   OPENAI_API_KEY=...
   HEYPI_DISCORD_CHANNELS=...
   HEYPI_DISCORD_USERS=...
   HEYPI_DISCORD_GROUPS=...
   HEYPI_DISCORD_APPROVERS=...
   HEYPI_DISCORD_APPROVER_GROUPS=...
   HEYPI_DISCORD_ADMINS=...
   HEYPI_DISCORD_ADMIN_GROUPS=...
   ```

### Preflight

```sh
pnpm exec heypi discord check
pnpm exec heypi discord channels <channel-name-or-id>
```

`DISCORD_CLIENT_ID` should be set for this QA pass so the example registers native commands at startup.

Use `discord observe` if you need to discover channel or user IDs:

```sh
pnpm exec heypi discord observe --timeout 60
```

### Run

```sh
pnpm dev
```

### Smoke prompts

In the configured Discord channel:

```text
@heypi help
@heypi create smoke.txt with "hello from discord" and attach it
@heypi run uname -a and tell me where it executed
```

Also test native commands:

```text
/status
/approvals
/bypasses
```

Expected result: mention-triggered replies work, native commands are registered when `DISCORD_CLIENT_ID` is set, generated files upload, configured admins can inspect broader approval/bypass state, and the Gondolin runtime starts or reports a clear setup error.

## Telegram

### Setup

1. Create a bot with `@BotFather`.
2. Add the bot to a test group or DM it directly.
3. For group smoke tests, disable privacy mode if the bot must see non-command messages.
4. Configure the example:

   ```sh
   cd examples/telegram-workout
   cp .env.example .env
   ```

5. Fill:

   ```env
   TELEGRAM_BOT_TOKEN=...
   OPENAI_API_KEY=...
   HEYPI_TELEGRAM_CHATS=-100...
   HEYPI_TELEGRAM_USERS=...
   ```

For a DM-only smoke test, leave the Telegram allowlists empty.

### Preflight

```sh
pnpm exec heypi telegram check
pnpm exec heypi telegram observe --timeout 60
```

Send `/start` or a message in the target chat while `observe` is running.

### Run

```sh
pnpm dev
```

### Smoke prompts

In the configured Telegram chat:

```text
/start
/status
help
create smoke.txt with "hello from telegram" and attach it
I ran 35 minutes easy today
Can you review my week?
```

Expected result: polling receives updates, slash commands work, generated files upload, and saved workout/profile state appears under `examples/telegram-workout/state`.

## Webhook

### Setup

```sh
cd examples/webhook-github-docker
cp .env.example .env
```

Fill:

```env
OPENAI_API_KEY=...
HEYPI_WEBHOOK_SECRET=dev-secret-change-me
HEYPI_GITHUB_REPO=owner/repo
HEYPI_WEBHOOK_PORT=3000
```

Docker must be running.

### Run

```sh
pnpm dev
```

### Smoke requests

Synchronous request:

```sh
curl -sS -X POST http://127.0.0.1:3000/webhook/github/threads/manual-smoke/messages \
  -H "authorization: Bearer dev-secret-change-me" \
  -H "content-type: application/json" \
  -d '{"user":"qa","sync":true,"text":"Say hello from webhook QA and include the current thread id if available."}'
```

Async request:

```sh
curl -sS -X POST http://127.0.0.1:3000/webhook/github/threads/manual-smoke/messages \
  -H "authorization: Bearer dev-secret-change-me" \
  -H "content-type: application/json" \
  -d '{"user":"qa","text":"Inspect the configured repo at a high level and summarize what kind of project it is."}'
```

Expected result: sync requests return a completed response, async requests return a `runId`, bad secrets are rejected, and Docker runtime errors are visible in the response or logs.

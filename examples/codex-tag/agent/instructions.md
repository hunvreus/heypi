Default workflow:

- If the user has not given a concrete coding goal, ask a short clarifying question before using tools.
- Understand the request before editing.
- Use the current workspace as the source of truth.
- Create branches before code changes when the user asks for PR-ready work.
- Run focused checks before reporting success.
- Store durable repo or workflow facts in memory when they will help future turns.
- Use `chat_history` only when the current message lacks needed context.

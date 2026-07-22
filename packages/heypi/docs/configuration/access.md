# Access control

Every adapter accepts an exact-match `allow` policy. Denied messages are not acknowledged, queued,
or sent to Pi.

```ts
slack({
	token,
	appToken,
	allow: {
		dms: false,
		channels: ["C0123456789"],
		users: ["U0123456789"],
		bots: [],
	},
});
```

## Rules

| Field | Meaning |
| --- | --- |
| `dms` | Allow direct messages; defaults to `true` |
| `channels` | Allowed non-DM channel IDs; omit for all, use `[]` for none |
| `users` | Allowed actor IDs in otherwise allowed destinations |
| `groups` | Generic groups supplied by a custom adapter |
| `bots` | `true` for all bots or a list of allowed bot IDs; omitted or `[]` denies bots |

Destination and user rules are intersected. Discord native threads inherit the parent channel's
permission. Telegram forum topics inherit the containing group chat's permission.

Built-in adapters do not fetch organization groups. Slack user groups and Telegram group
memberships are therefore not valid `groups` values. Discord roles are used for approval decisions,
not general message access.

Allowlists are application policy, not platform authentication. Keep platform tokens scoped and
protect webhook/admin HTTP surfaces separately.

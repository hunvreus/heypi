# Skills

Skills are small durable procedures for one scope. They are useful for runbooks, repeated channel workflows, service-specific investigation steps, and local conventions that should survive future turns.

**This page covers managed skills: scoped skills the agent can create and update at runtime. Bundled skills in `agent/skills/` ship with the app and are loaded by `agentFrom()`; see [Agent configuration](agent.md#prompt-files).**

## Config

Managed skills are off by default.

```ts
createHeypi({
	state: { root: "./state" },
	// ...adapters, agent, runtime
	approval: { approvers: { users: ["U123456"], groups: ["S123456"] } },
	skills: {
		enabled: true,
		scope: "channel",
		writePolicy: "approvers",
	},
});
```

`skills.scope` defaults to the top-level [`scope`](scope.md).

## Options

| Option | Required | Default | Description |
| --- | --- | --- | --- |
| `enabled` | No | `false` | Enables scoped skill tools and catalog injection. |
| `scope` | No | Top-level [`scope`](scope.md) | Skill sharing boundary. |
| `writePolicy` | No | See [Write policy](#write-policy) | Who can create, patch, replace, or delete skills. |
| `maxSkills` | No | `20` | Maximum skills per scope. |
| `maxChars` | No | `16_000` | Maximum skill body size. |

## Behavior

When enabled, heypi:

1. lists skills in the selected scope,
2. injects a compact skill catalog as background context,
3. exposes `skill_list`, `skill_read`, `skill_write`, `skill_patch`, and `skill_delete`,
4. allows mutation according to `skills.writePolicy`,
5. validates skill names, size, frontmatter, obvious secrets/private keys, and prompt-injection-shaped text.

The skill catalog is intentionally small. Full skill bodies are read only when the agent calls `skill_read`.

Skills are user-authored guidance, not trusted policy. They can help the model remember a workflow, but they must not override app config, approval policy, access control, or runtime safety.

## Format

`skill_write` takes `name`, `description`, and `content`. heypi generates the `SKILL.md` frontmatter:

```md
---
name: deploy-check
description: Check deployment health.
---

Run the health check command and summarize failures.
```

Skill names must use lowercase letters, numbers, `.`, `_`, or `-`.

Use `skill_patch` for exact replacements inside an existing skill. Ambiguous replacements fail unless `replaceAll` is set.

## Write policy

`skills.writePolicy` controls mutation:

- `auto`: the agent can create, patch, replace, and delete skills.
- `approvers`: only turns initiated by configured approver users or groups can mutate skills.
- `off`: skills can be listed, read, and injected, but cannot be changed.

Defaults:

- when `approval.approvers` is configured: `approvers` for `channel` and `user`.
- without approvers: `off`.
- `adapter` and `agent`: `off` unless explicitly overridden.

## Not included

heypi does not install, sync, or update third-party skill registries. It also does not expose supporting-file tools such as `skill_file_write`. Keep skills self-contained until that is needed.

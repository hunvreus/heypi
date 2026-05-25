# Server Inventory

The live remote-host inventory is stored in `examples/slack-devops/state/hosts.json` and managed through `hosts_list`, `hosts_lookup`, `hosts_upsert`, and `hosts_remove`.

If a user names a host that is not configured, ask for the missing host fields before using `hosts_upsert`.

## Host Fields

| Field | Required | Notes |
| --- | --- | --- |
| id | yes | Stable short name such as `web-1`, `db-1`, or `worker-a` |
| address | yes | DNS name or IP address |
| user | no | SSH user, defaults to `deploy` |
| port | no | SSH port, defaults to `22` |
| key | no | Key name, defaults to `default` |
| tags | no | Useful groups such as `prod`, `web`, `db`, `worker` |
| cwd | no | Remote working directory for commands |

## Onboarding Flow

1. Ask for host id, address, SSH user, SSH port if non-default, and tags.
2. Use `hosts_upsert` to save the host. The app handles the gate.
3. After approval, `hosts_upsert` returns the public key to install.
4. Tell the user to append that public key to `~/.ssh/authorized_keys` for the configured SSH user.
5. After the user confirms the key was installed, test the connection and refresh cached host facts.

## Rules

- Do not invent host names.
- Do not run commands against hosts that are not configured in the host inventory.
- For restart, deploy, rollback, or config changes, call the relevant tool with the concrete command. Do not ask for a plain-text "yes"; the app handles the gate.
- Prefer read-only diagnostics before remediation.

# Host Onboarding Runbook

Use this runbook when a user wants to add a VPS or Linux host to the Slack DevOps agent.

## Required Information

- Host id, e.g. `web-1`
- Address, e.g. a DNS name or IP address
- SSH user, defaults to `deploy`
- SSH port, defaults to `22`
- Tags, e.g. `prod`, `web`, `db`, `worker`
- Optional remote working directory

## Procedure

1. If the user only asks for the key, use `host_key_ensure` and show the public key.
2. If the user provides host details, use `hosts_upsert`.
3. After approval, `hosts_upsert` returns the public key to install.
4. Tell the user to append that public key to `~/.ssh/authorized_keys` for the configured SSH user.
5. When the user confirms the key is installed, test with `host_exec` using `hostname && uptime`.

## Boundaries

- Never print, read, copy, or ask for the private key.
- Do not use password SSH.
- Do not add a host without explicit user-provided address and SSH user.
- Do not run mutating commands while onboarding.

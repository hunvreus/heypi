# Deploy Rollback Runbook

Use this runbook when a user suspects a deploy caused an incident.

## When To Consider Rollback

- Error rate, latency, or service failures increased immediately after a deploy.
- The bad version is known.
- Dependency and host health checks do not explain the issue.
- The rollback command and target host/service are explicit.

## Safe Checks

1. Confirm host or tag, service name, deploy window, and known bad version.
2. Use `hosts_lookup` to resolve the target.
3. Use `host_exec` for read-only checks such as service status and recent logs.
4. State what evidence links the deploy to the incident.

## Approval Boundary

Rollback, restart, deploy, config writes, database changes, and cache flushes require approval.

Do not invent a rollback command. If the command is not provided or documented, ask for it.

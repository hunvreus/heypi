# Service Debugging Runbook

Use this runbook when a service is down, slow, or returning errors.

## Required Context

- Host id or tag
- Service name
- Symptom
- Approximate start time
- Recent deploy or config change if known

## Safe Checks

Run these through `host_exec`:

- `systemctl status <service> --no-pager`
- `journalctl -u <service> -n 120 --no-pager`
- `systemctl is-active <service>`
- `ss -ltnp`

## Remediation Boundary

Restarting, reloading, changing config, rolling back, or deploying requires approval.

If the user asks to restart without diagnostic context, inspect status and recent logs first unless the situation is urgent.

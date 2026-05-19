# Linux Health Check Runbook

Use this runbook for broad host health checks.

## Safe Checks

Run these through `host_exec` on configured hosts:

- `hostname && uptime`
- `df -h`
- `free -m`
- `systemctl --failed --no-pager`
- `journalctl -p warning..alert -n 80 --no-pager`

## Interpretation

- High load with low CPU idle suggests CPU pressure.
- High load with high iowait suggests disk pressure.
- Full disks require identifying large files before deleting anything.
- Failed systemd units require inspecting status and recent logs before restart.

## Remediation Boundary

Restarts, package installs, file deletion, config edits, service enable/disable, deploys, and rollbacks require approval.

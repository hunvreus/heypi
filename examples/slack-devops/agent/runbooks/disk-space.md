# Disk Space Runbook

Use this runbook when a host has low disk space or a full filesystem.

## Safe Checks

Run these through `host_exec`:

- `df -h`
- `du -xh /var/log 2>/dev/null | sort -h | tail -20`
- `journalctl --disk-usage`
- `find /tmp -xdev -type f -mtime +7 -printf '%s %p\n' 2>/dev/null | sort -n | tail -20`

## Safe Interpretation

- Prefer identifying the filesystem first.
- Prefer logs and temporary files before application data.
- Do not delete files until the user approves a specific deletion command.

## Approval Boundary

Deletion, truncation, package cleanup, Docker prune, and journal vacuum commands require approval.

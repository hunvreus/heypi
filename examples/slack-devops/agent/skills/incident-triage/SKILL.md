---
name: incident-triage
description: Triage Linux/VPS incidents by checking bundled runbooks, resolving configured hosts, running safe diagnostics, and proposing a minimal remediation plan.
---

# Incident Triage

Use this skill when the user reports a host issue, service outage, degraded service, elevated errors, deployment issue, disk pressure, resource saturation, or unknown production behavior.

## Objectives

1. Confirm impact and scope quickly.
2. Gather only the minimum diagnostics needed.
3. Prefer safe, read-only checks first.
4. For risky or mutating actions, call the relevant tool with concrete inputs.
5. End with a short remediation proposal and next verification checks.

## Workflow

1. Clarify incident context
- Ask for host id or tag, service name if relevant, observed symptom, start time, and impact.
- If unknown, state assumptions explicitly.

2. Load relevant runbook context
- Use `runbook_search` with concrete keywords (`host onboarding`, `linux health`, `disk`, `service`, `logs`, `rollback`, `ssh`, etc.).
- Prefer runbook procedures over ad-hoc steps.
- Use runbooks for operational context and hosts_list/hosts_lookup for configured remote hosts.

3. Execute safe diagnostics first
- Use `bash` for read-only checks against the configured workspace (`ls`, `cat`, `grep`, `find`, log inspection).
- Use `host_exec` for read-only remote checks such as `hostname`, `uptime`, `df -h`, `free -m`, `systemctl status`, and log inspection. Include a concise purpose for each remote command.
- Keep commands scoped and auditable.

4. Propose minimal remediation
- If action is risky (restart/deploy/write/network/package changes), call the relevant tool with the concrete command and a concise purpose. Do not ask for a plain-text "yes"; the app handles the gate.
- If blocked or denied, offer fallback checks and escalation steps.

5. Close with status
- Summarize: observed facts, likely cause, actions taken, current state, and next checks.

## Guardrails

- Do not execute destructive commands unless explicitly required. Call the relevant tool with the concrete command.
- Do not modify the agent's own files, instructions, runbooks, package files, or source code.
- Keep command blast radius as small as possible.
- Prefer deterministic, reversible changes.
- Keep output concise and operational.

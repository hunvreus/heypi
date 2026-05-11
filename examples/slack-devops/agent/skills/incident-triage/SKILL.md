---
name: incident-triage
description: Triage production incidents by gathering symptoms, checking runbooks, running safe diagnostics, and proposing a minimal remediation plan with approvals for risky commands.
---

# Incident Triage

Use this skill when the user reports an outage, degraded service, elevated errors, or unknown production behavior.

## Objectives

1. Confirm impact and scope quickly.
2. Gather only the minimum diagnostics needed.
3. Prefer safe, read-only checks first.
4. Use approvals for risky or mutating actions.
5. End with a short remediation proposal and next verification checks.

## Workflow

1. Clarify incident context
- Ask for service/system name, observed symptom, start time, and impact.
- If unknown, state assumptions explicitly.

2. Load relevant runbook context
- Use `runbook_search` with concrete keywords (`service`, `error`, `timeout`, `deployment`, etc.).
- Prefer runbook procedures over ad-hoc steps.

3. Execute safe diagnostics first
- Use `bash` for read-only checks (`ls`, `cat`, `grep`, `ps`, `df`, `free`, `curl -I`, logs).
- Keep commands scoped and auditable.

4. Propose minimal remediation
- If action is risky (deploy/restart/write/network changes), ask for approval and explain why.
- If blocked or denied, offer fallback checks and escalation steps.

5. Close with status
- Summarize: observed facts, likely cause, actions taken, current state, and next checks.

## Guardrails

- Do not execute destructive commands unless explicitly required and approved.
- Keep command blast radius as small as possible.
- Prefer deterministic, reversible changes.
- Keep output concise and operational.

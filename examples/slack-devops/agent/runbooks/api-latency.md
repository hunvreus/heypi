# API Latency Runbook

## Symptoms

- Elevated p95 and p99 latency
- Increased timeout rate from gateway
- Customer reports slow responses

## Initial checks

1. Verify deploy timeline and recent config changes.
2. Check process saturation (CPU, memory, file descriptors).
3. Check downstream dependency latency (DB/cache/external API).

## Safe diagnostics

- `bash`: inspect logs and error rates.
- `bash`: check host pressure (`top`, `vmstat`, `df -h`).
- `runbook_search`: lookup service-specific timeout guidance.

## Remediation hints

- Roll back recent high-risk deploy if correlated.
- Scale read replicas or cache capacity if dependency bottleneck is confirmed.
- Use restart/redeploy only with approval and clear rollback path.

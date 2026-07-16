# Atlas CRM

Internal customer platform (demo) used by employees across **APAC / EMEA / Americas**.
Single-file Node HTTP server, zero dependencies. Built to demonstrate a
monitoring-to-Major-Incident flow: a region can be broken on demand, `/api/health`
flips to 503, a GCP uptime check fails, and an alert opens a Major Incident in Atomicwork.

## Run locally
```bash
node server.js          # serves on :8791 (or $PORT)
```

## Endpoints
| Method | Path | Purpose |
|--------|------|---------|
| GET | `/` | Employee CRM UI (region switcher, accounts, KPIs) |
| GET | `/control` | Operator panel to break/restore regions |
| GET | `/api/health` | Overall health (503 if any region down); `?region=APAC` per-region |
| GET | `/api/accounts?region=APAC` | Account data, or 503 when that region is down |
| POST | `/api/control/break` | `{ "region": "APAC" \| "all" }` (needs `x-control-token`) |
| POST | `/api/control/restore` | `{ "region": "APAC" \| "all" }` |

`CONTROL_TOKEN` (env, default `atlas-demo-2026`) protects the break/restore endpoints.
State is in-memory, so run a single instance (Cloud Run `--min-instances 1 --max-instances 1`).

## Deploy (Cloud Run)
```bash
./deploy.sh             # atomicwork-gcp-demo / asia-south1 / service atlas-crm
```
Note: Cloud Run's front end reserves `/healthz`, so the health path is `/api/health`.

## Monitoring → incident chain
```
/api/health 503  →  GCP uptime check fails  →  "Atlas CRM Down" alert policy
   →  webhook  →  gateway  →  Major Incident in Atomicwork (atomicgws WS 2387)
```

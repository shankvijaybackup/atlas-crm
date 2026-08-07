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
| GET | `/` | Employee sign-in page; on success, that user's own dashboard (their region accounts, KPIs). No other-user data. |
| POST | `/api/login` | `{ "email": "..." }`. Admin emails (`@atomicwork.com`, `vijay*`) route to `/control`; a general user gets a 503 + localized sign-in error while their region is down |
| GET | `/control` | Operator console: region health, live sign-in feed (all regions), break/restore |
| GET | `/api/health` | Overall health (503 if any region down); `?region=APAC` per-region |
| GET | `/api/accounts?region=APAC` | Account data (stays available during an auth outage) |
| GET | `/api/activity?region=APAC` | Live sign-in activity feed (successes, or accumulating failures) |
| POST | `/api/control/break` | `{ "region": "APAC" \| "all" }` (needs `x-control-token`) |
| POST | `/api/control/restore` | `{ "region": "APAC" \| "all" }` |

`CONTROL_TOKEN` (env, default `atlas-demo-2026`) protects the break/restore endpoints.
State is in-memory, so run a single instance (Cloud Run `--min-instances 1 --max-instances 1`).

## Deploy (Cloud Run)
```bash
./deploy.sh             # atomicwork-gcp-demo / asia-south1 / service atlas-crm-ops
```
Note: Cloud Run's front end reserves `/healthz`, so the health path is `/api/health`.
Note: `deploy.sh` sets env vars, so export `AW_API_KEY` before running or deploy with
`--source .` and no `--set-env-vars` so Cloud Run preserves the live incident-filing key.

## Monitoring → incident chain
```
/api/health 503  →  GCP uptime check fails  →  "Atlas CRM Down" alert policy
   →  webhook  →  gateway  →  Major Incident in Atomicwork (atomicgws WS 2387)
```

## Localization & demo control
UI is available in **English / French / German** (switcher in the top bar; sign-in errors, dashboard KPIs and tables all translated). Outages are simulated from the Operator console (`/control`): sign in with an `@atomicwork.com` email or open `/control` directly, then "Simulate outage" (per region) or "Simulate all (sign-in)" (all regions, also files the incident set).

## Demo sign-in accounts
- General users: `luke@valeo.com`, `lisa@valeo.com` (any password). During an outage they get a real localized sign-in error and nothing else, no other-user data.
- Admin / operator: any `@atomicwork.com` email (for example `vijay@atomicwork.com`) routes to the operator console.

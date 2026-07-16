#!/usr/bin/env bash
# Deploy Atlas CRM to Cloud Run so GCP Monitoring can reach /api/health.
# Single instance (min=max=1) so the in-memory break state is consistent.
set -euo pipefail

PROJECT="${PROJECT:-atomicwork-gcp-demo}"
REGION="${REGION:-asia-south1}"
SERVICE="${SERVICE:-atlas-crm}"
CONTROL_TOKEN="${CONTROL_TOKEN:-atlas-demo-2026}"

gcloud run deploy "$SERVICE" \
  --project "$PROJECT" --region "$REGION" --source . \
  --min-instances 1 --max-instances 1 \
  --set-env-vars "CONTROL_TOKEN=${CONTROL_TOKEN}" \
  --allow-unauthenticated --quiet

URL="$(gcloud run services describe "$SERVICE" --project "$PROJECT" --region "$REGION" --format='value(status.url)')"
echo ""
echo "Atlas CRM:        ${URL}"
echo "Employee view:    ${URL}/"
echo "Operator panel:   ${URL}/control"
echo "Health (monitor): ${URL}/api/health"
echo ""
echo "Next: create an uptime check on ${URL}/api/health and an alert policy"
echo "that webhooks Atomicwork to open the Major Incident."

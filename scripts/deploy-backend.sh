#!/usr/bin/env bash
set -euo pipefail
PROJECT_ID="wedding-490801"
REGION="us-central1"
SERVICE="wedding-photos-backend"
SERVICE_URL="https://wedding-photos-backend-908592617843.us-central1.run.app"
ACCOUNT="wedding-photos@${PROJECT_ID}.iam.gserviceaccount.com"
OWNER_EMAIL="$(gcloud auth list --filter=status:ACTIVE --format='value(account)')"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
REVISION="$(git -C "$ROOT" rev-parse --short HEAD 2>/dev/null || date +%Y%m%d%H%M%S)"
IMAGE="${REGION}-docker.pkg.dev/${PROJECT_ID}/wedding-photos/backend:${REVISION}"

cd "$ROOT/backend"
npm ci
npm test
gcloud builds submit . --tag "$IMAGE" --project "$PROJECT_ID" --quiet
gcloud run deploy "$SERVICE" \
  --project "$PROJECT_ID" --region "$REGION" --image "$IMAGE" \
  --service-account "$ACCOUNT" --allow-unauthenticated \
  --cpu 1 --memory 512Mi --min-instances 0 --max-instances 4 \
  --concurrency 20 --timeout 3600 --cpu-throttling \
  --set-env-vars "NODE_ENV=production,PROJECT_ID=${PROJECT_ID},OWNER_EMAIL=${OWNER_EMAIL},FRONTEND_ORIGIN=https://aaronkbutler.github.io,PUBLIC_BASE_URL=${SERVICE_URL},OAUTH_CONFIG_SECRET=wedding-photos-oauth,DRIVE_REFRESH_SECRET=wedding-photos-drive-refresh,FRONTEND_URL=https://aaronkbutler.github.io/wedding-photos/" \
  --set-secrets "ADMIN_KEY=wedding-photos-admin-key:latest,SIGNING_KEY=wedding-photos-signing-key:latest,EVENT_KEY=wedding-photos-event-key:latest" \
  --quiet
printf '%s\n' "$SERVICE_URL"

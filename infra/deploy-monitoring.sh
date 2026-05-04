#!/usr/bin/env bash
# deploy-monitoring.sh — Deploy the monitoring + budget stack
# Usage: ./infra/deploy-monitoring.sh your@email.com [budget_usd]

set -euo pipefail

# ── Load personal config ──────────────────────────────
ENV_FILE="$(dirname "$0")/deploy.env"
if [[ ! -f "$ENV_FILE" ]]; then
  echo "Error: $ENV_FILE not found. Copy deploy.env.example and fill in your values."
  exit 1
fi
source "$ENV_FILE"

PROFILE="${AWS_PROFILE:?AWS_PROFILE not set in deploy.env}"
DIST_ID="${DIST_ID:?DIST_ID not set in deploy.env}"

REGION="us-east-1"
STACK_NAME="writing-world-monitoring"

EMAIL="${1:-}"
BUDGET="${2:-10}"

if [[ -z "$EMAIL" ]]; then
  echo "Usage: ./infra/deploy-monitoring.sh your@email.com [monthly_budget_usd]"
  exit 1
fi

echo "▶ Deploying monitoring stack…"
aws cloudformation deploy \
  --profile "$PROFILE" \
  --region  "$REGION" \
  --stack-name "$STACK_NAME" \
  --template-file "$(dirname "$0")/monitoring.yaml" \
  --no-fail-on-empty-changeset \
  --parameter-overrides \
    AlertEmail="$EMAIL" \
    MonthlyBudgetUSD="$BUDGET" \
    DistributionId="$DIST_ID"

echo "✓ Monitoring deployed."
echo ""
echo "  You will receive a confirmation email to $EMAIL — click the link to activate alerts."
echo "  View budget: https://console.aws.amazon.com/billing/home#/budgets"
echo "  View alarms: https://console.aws.amazon.com/cloudwatch/home?region=us-east-1#alarmsV2:"

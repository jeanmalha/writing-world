#!/usr/bin/env bash
# deploy.sh — Deploy Writing World to AWS
# Usage:
#   ./infra/deploy.sh          # first deploy (creates stack)
#   ./infra/deploy.sh update   # subsequent deploys (update stack + sync files)
#   ./infra/deploy.sh sync     # sync files only (stack already up to date)

set -euo pipefail

# ── Load personal config ──────────────────────────────
ENV_FILE="$(dirname "$0")/deploy.env"
if [[ ! -f "$ENV_FILE" ]]; then
  echo "Error: $ENV_FILE not found. Copy deploy.env.example and fill in your values."
  exit 1
fi
# shellcheck source=deploy.env
source "$ENV_FILE"

PROFILE="${AWS_PROFILE:?AWS_PROFILE not set in deploy.env}"
DOMAIN="${DOMAIN:?DOMAIN not set in deploy.env}"

REGION="us-east-1"          # MUST be us-east-1 for ACM + CloudFront
STACK_NAME="writing-world"
TEMPLATE="$(dirname "$0")/stack.yaml"
APP_DIR="$(dirname "$0")/.."

# ── Colours ──────────────────────────────────────────
GREEN='\033[0;32m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'; NC='\033[0m'
info()    { echo -e "${CYAN}▶ $*${NC}"; }
success() { echo -e "${GREEN}✓ $*${NC}"; }
warn()    { echo -e "${YELLOW}⚠ $*${NC}"; }

ACTION="${1:-deploy}"

# ── 1. Deploy / update CloudFormation stack ──────────
if [[ "$ACTION" != "sync" ]]; then
  info "Deploying CloudFormation stack '$STACK_NAME' to ${REGION}..."
  aws cloudformation deploy \
    --profile "$PROFILE" \
    --region  "$REGION" \
    --stack-name "$STACK_NAME" \
    --template-file "$TEMPLATE" \
    --capabilities CAPABILITY_NAMED_IAM \
    --no-fail-on-empty-changeset

  success "Stack deployed."
fi

# ── 2. Fetch outputs ──────────────────────────────────
info "Fetching stack outputs…"

BUCKET=$(aws cloudformation describe-stacks \
  --profile "$PROFILE" \
  --region  "$REGION" \
  --stack-name "$STACK_NAME" \
  --query "Stacks[0].Outputs[?OutputKey=='BucketName'].OutputValue" \
  --output text)

DIST_ID=$(aws cloudformation describe-stacks \
  --profile "$PROFILE" \
  --region  "$REGION" \
  --stack-name "$STACK_NAME" \
  --query "Stacks[0].Outputs[?OutputKey=='DistributionId'].OutputValue" \
  --output text)

CF_DOMAIN=$(aws cloudformation describe-stacks \
  --profile "$PROFILE" \
  --region  "$REGION" \
  --stack-name "$STACK_NAME" \
  --query "Stacks[0].Outputs[?OutputKey=='DistributionDomain'].OutputValue" \
  --output text)

echo "  Bucket:       $BUCKET"
echo "  Distribution: $DIST_ID"
echo "  CF Domain:    https://$CF_DOMAIN"

# ── 3. Build versioned assets into a temp directory ──
#
# Caching strategy:
#   - JS/CSS: max-age=1year + immutable (aggressive browser + CDN caching)
#   - index.html: max-age=3600 (1 hour); CloudFront invalidation on every
#     deploy ensures CDN always serves fresh HTML immediately after release.
#
# Cache-busting: a Unix timestamp is injected as ?v=<ts> into every
# ES module import statement in every JS file, and into the <script>/<link>
# tags in index.html. Since all asset URLs change on each deploy, browsers
# treat them as new resources and fetch fresh — then cache for a year.
#
DEPLOY_VERSION=$(date +%s)
TMPDIR=$(mktemp -d /tmp/writingworld-deploy.XXXXXX)
mkdir -p "$TMPDIR/js"

info "Stamping version $DEPLOY_VERSION into JS imports…"

for src in "$APP_DIR"/js/*.js; do
  fname=$(basename "$src")
  # Rewrite:  from './foo.js'   →   from './foo.js?v=<ts>'
  sed "s/from '\(\.\/[^']*\.js\)'/from '\1?v=${DEPLOY_VERSION}'/g" \
    "$src" > "$TMPDIR/js/$fname"
done

# CSS (no imports to rewrite, just copy)
cp "$APP_DIR/style.css" "$TMPDIR/style.css"

# index.html: stamp the <script src> and <link href> entry points
sed \
  -e "s|src=\"js/\([^\"]*\)\.js\"|src=\"js/\1.js?v=${DEPLOY_VERSION}\"|g" \
  -e "s|href=\"\([^\"]*\)\.css\"|href=\"\1.css?v=${DEPLOY_VERSION}\"|g" \
  "$APP_DIR/index.html" > "$TMPDIR/index.html"

success "Version stamping done."

# ── 4. Upload to S3 ───────────────────────────────────
info "Uploading to s3://$BUCKET …"

# JS files — immutable, cached forever (URL changes each deploy)
aws s3 sync "$TMPDIR/js" "s3://$BUCKET/js" \
  --profile "$PROFILE" \
  --delete \
  --cache-control "public, max-age=31536000, immutable"

# CSS — immutable
aws s3 cp "$TMPDIR/style.css" "s3://$BUCKET/style.css" \
  --profile "$PROFILE" \
  --cache-control "public, max-age=31536000, immutable" \
  --content-type "text/css"

# index.html — short cache; CloudFront invalidation keeps CDN fresh on deploy
aws s3 cp "$TMPDIR/index.html" "s3://$BUCKET/index.html" \
  --profile "$PROFILE" \
  --cache-control "public, max-age=3600" \
  --content-type "text/html"

rm -rf "$TMPDIR"
success "Files uploaded."

# ── 5. Invalidate CloudFront cache ────────────────────
info "Invalidating CloudFront cache…"

INVALIDATION_ID=$(aws cloudfront create-invalidation \
  --profile "$PROFILE" \
  --distribution-id "$DIST_ID" \
  --paths "/*" \
  --query "Invalidation.Id" \
  --output text)

success "Invalidation created: $INVALIDATION_ID"

# ── 6. Done ───────────────────────────────────────────
echo ""
success "Deployment complete! (version: $DEPLOY_VERSION)"
echo -e "  ${GREEN}https://${DOMAIN}${NC}"
echo -e "  ${CYAN}https://$CF_DOMAIN${NC}  (CloudFront domain)"

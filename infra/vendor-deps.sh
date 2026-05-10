#!/usr/bin/env bash
# vendor-deps.sh — Build and self-host the AI inference bundle on our S3/CloudFront.
#
# Produces a single self-contained ESM bundle (lore-ai.mjs) via esbuild so there
# are no external module specifiers and no importmap whack-a-mole.
# WASM binaries are kept external (can't bundle binary) and served alongside the JS.
#
# Usage: ./infra/vendor-deps.sh

set -euo pipefail

SCRIPT_DIR="$(dirname "$0")"
APP_DIR="$SCRIPT_DIR/.."
source "$SCRIPT_DIR/deploy.env"

PROFILE="${AWS_PROFILE:?}"
REGION="us-east-1"
DOMAIN="${DOMAIN:?DOMAIN not set in deploy.env}"

GREEN='\033[0;32m'; CYAN='\033[0;36m'; YELLOW='\033[1;33m'; NC='\033[0m'
info()    { echo -e "${CYAN}▶ $*${NC}"; }
success() { echo -e "${GREEN}✓ $*${NC}"; }
warn()    { echo -e "${YELLOW}⚠ $*${NC}"; }

BUCKET=$(aws cloudformation describe-stacks \
  --profile "$PROFILE" --region "$REGION" \
  --stack-name writing-world \
  --query "Stacks[0].Outputs[?OutputKey=='BucketName'].OutputValue" \
  --output text)

echo "  Bucket: $BUCKET  Domain: $DOMAIN"

# ── Install packages ───────────────────────────────────────────────────────────
WORK=$(mktemp -d)
trap "rm -rf $WORK" EXIT

info "Installing npm packages…"
npm install \
  @huggingface/transformers \
  onnxruntime-web \
  onnxruntime-common \
  esbuild \
  --prefix "$WORK" --no-save --silent 2>/dev/null

TFM_VER=$(node -p "require('$WORK/node_modules/@huggingface/transformers/package.json').version")
ORT_VER=$(node -p "require('$WORK/node_modules/onnxruntime-web/package.json').version")
info "  @huggingface/transformers: $TFM_VER  onnxruntime-web: $ORT_VER"

# ── Build self-contained ESM bundle ───────────────────────────────────────────
info "Building lore-ai.mjs with esbuild…"

cat > "$WORK/entry.mjs" << 'ENTRY'
export { pipeline, TextStreamer, env } from '@huggingface/transformers';
ENTRY

cat > "$WORK/ort-webgpu-entry.mjs" << 'ENTRY'
export * from 'onnxruntime-web/webgpu';
ENTRY

ESBUILD="$WORK/node_modules/.bin/esbuild"
ESBUILD_FLAGS=(--bundle --format=esm --platform=browser --conditions=browser
               --target=es2022 --external:'*.wasm'
               --define:process.env.NODE_ENV='"production"' --log-level=warning)

"$ESBUILD" "$WORK/entry.mjs"          "${ESBUILD_FLAGS[@]}" --outfile="$WORK/lore-ai.mjs"
"$ESBUILD" "$WORK/ort-webgpu-entry.mjs" "${ESBUILD_FLAGS[@]}" --outfile="$WORK/ort-webgpu.mjs"

success "Bundles built: lore-ai $(du -sh "$WORK/lore-ai.mjs"|cut -f1)  ort-webgpu $(du -sh "$WORK/ort-webgpu.mjs"|cut -f1)"

# ── Upload to S3 ──────────────────────────────────────────────────────────────
upload_js() {
  aws s3 cp "$1" "s3://$BUCKET/vendor/$2" \
    --profile "$PROFILE" \
    --cache-control "public, max-age=31536000, immutable" \
    --content-type "application/javascript" \
    --no-cli-pager
  echo "  → /vendor/$2 ($(du -sh "$1" | cut -f1))"
}
upload_wasm() {
  aws s3 cp "$1" "s3://$BUCKET/vendor/$2" \
    --profile "$PROFILE" \
    --cache-control "public, max-age=31536000, immutable" \
    --content-type "application/wasm" \
    --no-cli-pager
  echo "  → /vendor/$2 ($(du -sh "$1" | cut -f1))"
}

ORT="$WORK/node_modules/onnxruntime-web/dist"

info "Uploading to S3…"
upload_js "$WORK/lore-ai.mjs"    "lore-ai.mjs"
upload_js "$WORK/ort-webgpu.mjs" "ort-webgpu.mjs"

# WASM binaries must sit at /vendor/ (same dir as the bundle) so ORT's
# import.meta.url-based resolution finds them automatically.
upload_wasm "$ORT/ort-wasm-simd-threaded.wasm"      "ort-wasm-simd-threaded.wasm"
upload_wasm "$ORT/ort-wasm-simd-threaded.jsep.wasm" "ort-wasm-simd-threaded.jsep.wasm"
upload_js   "$ORT/ort-wasm-simd-threaded.mjs"       "ort-wasm-simd-threaded.mjs"
upload_js   "$ORT/ort-wasm-simd-threaded.jsep.mjs"  "ort-wasm-simd-threaded.jsep.mjs"

success "All files uploaded."

# ── Patch index.html importmap ────────────────────────────────────────────────
AI_URL="https://${DOMAIN}/vendor/lore-ai.mjs"
ORT_WEBGPU_URL="https://${DOMAIN}/vendor/ort-webgpu.mjs"

python3 - "$APP_DIR/index.html" "$AI_URL" "$ORT_WEBGPU_URL" << 'PYEOF'
import re, sys
path, ai_url, ort_url = sys.argv[1], sys.argv[2], sys.argv[3]
html = open(path).read()
new_imports = (
  f'"imports": {{\n'
  f'      "@huggingface/transformers": "{ai_url}",\n'
  f'      "onnxruntime-web/webgpu":    "{ort_url}"\n'
  f'    }}'
)
html = re.sub(r'"imports"\s*:\s*\{[^}]*\}', new_imports, html, flags=re.DOTALL)
open(path, 'w').write(html)
PYEOF

success "index.html importmap updated"
echo "  @huggingface/transformers → $AI_URL"
echo "  onnxruntime-web/webgpu   → $ORT_WEBGPU_URL"
echo ""
warn "Run ./infra/deploy.sh sync to push the updated index.html."

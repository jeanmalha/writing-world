#!/usr/bin/env bash
# vendor-deps.sh — Download npm packages and self-host them on our S3/CloudFront.
# Run this whenever you want to update a vendored dependency.
#
# Usage: ./infra/vendor-deps.sh

set -euo pipefail

SCRIPT_DIR="$(dirname "$0")"
APP_DIR="$SCRIPT_DIR/.."
source "$SCRIPT_DIR/deploy.env"

PROFILE="${AWS_PROFILE:?}"
REGION="us-east-1"

GREEN='\033[0;32m'; CYAN='\033[0;36m'; YELLOW='\033[1;33m'; NC='\033[0m'
info()    { echo -e "${CYAN}▶ $*${NC}"; }
success() { echo -e "${GREEN}✓ $*${NC}"; }
warn()    { echo -e "${YELLOW}⚠ $*${NC}"; }

# ── Fetch stack outputs ────────────────────────────────────────────────────────
BUCKET=$(aws cloudformation describe-stacks \
  --profile "$PROFILE" --region "$REGION" \
  --stack-name writing-world \
  --query "Stacks[0].Outputs[?OutputKey=='BucketName'].OutputValue" \
  --output text)

DOMAIN="${DOMAIN:?DOMAIN not set in deploy.env}"

echo "  Bucket: $BUCKET"
echo "  Domain: $DOMAIN"

# ── Install packages into a temp directory ─────────────────────────────────────
WORK=$(mktemp -d)
trap "rm -rf $WORK" EXIT

info "Installing npm packages…"
npm install \
  @huggingface/transformers \
  onnxruntime-web \
  --prefix "$WORK" --no-save --silent 2>/dev/null
success "Packages installed."

TFM_PKG="$WORK/node_modules/@huggingface/transformers"
ORT_PKG="$WORK/node_modules/onnxruntime-web"

TFM_VER=$(node -p "require('$TFM_PKG/package.json').version")
ORT_VER=$(node -p "require('$ORT_PKG/package.json').version")
echo "  @huggingface/transformers: $TFM_VER"
echo "  onnxruntime-web:           $ORT_VER"

upload_js() {
  local src="$1" key="$2"
  aws s3 cp "$src" "s3://$BUCKET/$key" \
    --profile "$PROFILE" \
    --cache-control "public, max-age=31536000, immutable" \
    --content-type "application/javascript" \
    --no-cli-pager
  echo "  → $key"
}

upload_wasm() {
  local src="$1" key="$2"
  aws s3 cp "$src" "s3://$BUCKET/$key" \
    --profile "$PROFILE" \
    --cache-control "public, max-age=31536000, immutable" \
    --content-type "application/wasm" \
    --no-cli-pager
  echo "  → $key ($(du -sh "$src" | cut -f1))"
}

# ── @huggingface/transformers — browser ESM bundle ────────────────────────────
info "Uploading @huggingface/transformers@$TFM_VER …"
upload_js "$TFM_PKG/dist/transformers.web.min.js" "vendor/transformers/transformers.web.min.js"
success "Transformers.js uploaded."

# ── onnxruntime-web — JS bundles (importmap) + WASM binaries ──────────────────
info "Uploading onnxruntime-web@$ORT_VER …"

# JS bundle for onnxruntime-web/webgpu (only subpath Transformers.js imports)
upload_js "$ORT_PKG/dist/ort.webgpu.bundle.min.mjs" "vendor/ort-web/ort.webgpu.bundle.min.mjs"

# WASM binaries loaded at runtime via env.backends.onnx.wasm.wasmPaths
upload_js   "$ORT_PKG/dist/ort-wasm-simd-threaded.jsep.mjs"  "vendor/ort-web/ort-wasm-simd-threaded.jsep.mjs"
upload_wasm "$ORT_PKG/dist/ort-wasm-simd-threaded.jsep.wasm" "vendor/ort-web/ort-wasm-simd-threaded.jsep.wasm"
upload_js   "$ORT_PKG/dist/ort-wasm-simd-threaded.mjs"       "vendor/ort-web/ort-wasm-simd-threaded.mjs"
upload_wasm "$ORT_PKG/dist/ort-wasm-simd-threaded.wasm"      "vendor/ort-web/ort-wasm-simd-threaded.wasm"

success "ORT files uploaded."

# ── Patch index.html importmap ────────────────────────────────────────────────
TFM_URL="https://${DOMAIN}/vendor/transformers/transformers.web.min.js"
ORT_WEBGPU_URL="https://${DOMAIN}/vendor/ort-web/ort.webgpu.bundle.min.mjs"

IMPORTMAP=$(cat <<IMAP
    "imports": {
      "@huggingface/transformers": "${TFM_URL}",
      "onnxruntime-web/webgpu":    "${ORT_WEBGPU_URL}"
    }
IMAP
)

# Replace everything between the outer braces of the importmap
python3 - "$APP_DIR/index.html" <<PYEOF
import re, sys
path = sys.argv[1]
html = open(path).read()
new_map = '''${IMPORTMAP}'''
html = re.sub(
    r'("imports"\s*:\s*\{)[^}]*(})',
    lambda m: new_map,
    html, flags=re.DOTALL
)
open(path, 'w').write(html)
PYEOF

success "index.html importmap updated."
echo ""
echo "  Transformers.js:        $TFM_URL"
echo "  onnxruntime-web/webgpu: $ORT_WEBGPU_URL"
echo ""
warn "Run ./infra/deploy.sh sync to push the updated index.html."

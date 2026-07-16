#!/usr/bin/env bash
# Deploy the SHOGUN LP to Cloudflare Pages (direct upload — no build step).
#
# One-time auth (browser, ~30s): `npx wrangler login`
# Then, from the repo root:  ./lp/deploy.sh [preview|production]
#
# - preview (default): deploys to a `preview` branch → unique *.pages.dev URL,
#   safe for iterating without touching the live domain.
# - production: deploys to the project's production URL (and syogun.com once the
#   custom domain is attached in the Cloudflare dashboard).
set -euo pipefail

PROJECT="shogun-lp"
MODE="${1:-preview}"
DIR="$(cd "$(dirname "$0")" && pwd)"   # the lp/ directory

case "$MODE" in
  preview)    BRANCH_ARGS=(--branch preview) ;;
  production) BRANCH_ARGS=() ;;           # default branch = production
  *) echo "usage: $0 [preview|production]"; exit 1 ;;
esac

echo "Deploying $DIR to Cloudflare Pages project '$PROJECT' ($MODE)…"
npx wrangler pages deploy "$DIR" --project-name "$PROJECT" "${BRANCH_ARGS[@]}"

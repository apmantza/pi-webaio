#!/usr/bin/env bash
# sync-cdp.sh — diff CDP files between greedysearch-pi and pi-webaio
# Run from pi-webaio root. Reports drift and optionally syncs.
#
# Usage:
#   bash scripts/sync-cdp.sh          # report drift only
#   bash scripts/sync-cdp.sh --sync   # copy from greedysearch-pi to pi-webaio

set -euo pipefail

GS="../greedysearch-pi"
WB="."

SHARED_FILES=(
  "bin/cdp.mjs"
  "bin/launch.mjs"
  "extractors/common.mjs"
  "extractors/consent.mjs"
  "extractors/selectors.mjs"
  "extractors/google-ai.mjs"
  "extractors/gemini.mjs"
  "extractors/google-search.mjs"
  "src/search/constants.mjs"
  "src/search/chrome.mjs"
  "src/search/engines.mjs"
)

SYNC="${1:-}"

drift=0
for f in "${SHARED_FILES[@]}"; do
  if [ ! -f "$GS/$f" ]; then
    echo "MISSING: $f (not in greedysearch-pi)"
    drift=1
    continue
  fi
  if [ ! -f "$WB/$f" ]; then
    echo "MISSING: $f (not in pi-webaio)"
    drift=1
    continue
  fi
  if ! diff -q "$GS/$f" "$WB/$f" >/dev/null 2>&1; then
    echo "DRIFT: $f"
    if [ "$SYNC" = "--sync" ]; then
      cp "$GS/$f" "$WB/$f"
      echo "  → synced from greedysearch-pi"
    fi
    drift=1
  fi
done

if [ "$drift" -eq 0 ]; then
  echo "All ${#SHARED_FILES[@]} shared files in sync."
else
  echo ""
  echo "Run 'bash scripts/sync-cdp.sh --sync' to pull from greedysearch-pi."
fi

#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TOOLS_DIR="$(${SCRIPT_DIR}/resolve-browser-tools.sh)"

if [[ ! -d "${TOOLS_DIR}/node_modules" ]]; then
  echo "browser-tools dependencies are missing (${TOOLS_DIR}/node_modules)." >&2
  echo "Run: npm run setup" >&2
  exit 1
fi

exec "${TOOLS_DIR}/browser-content.js" "$@"

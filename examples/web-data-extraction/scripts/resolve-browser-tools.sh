#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

if [[ -n "${BROWSER_TOOLS_DIR:-}" && -x "${BROWSER_TOOLS_DIR}/browser-content.js" ]]; then
  echo "${BROWSER_TOOLS_DIR}"
  exit 0
fi

CANDIDATES=(
  "${PROJECT_DIR}/.pi/skills/browser-tools"
  "${PROJECT_DIR}/.pi/git/github.com/badlogic/pi-skills/browser-tools"
  "${PROJECT_DIR}/.pi/npm/node_modules/pi-skills/browser-tools"
)

for dir in "${CANDIDATES[@]}"; do
  if [[ -x "${dir}/browser-content.js" ]]; then
    echo "${dir}"
    exit 0
  fi
done

found="$(find "${PROJECT_DIR}/.pi" -type f -path "*/browser-tools/browser-content.js" -print -quit 2>/dev/null || true)"
if [[ -n "${found}" ]]; then
  dirname "${found}"
  exit 0
fi

echo "Could not locate browser-tools in ${PROJECT_DIR}/.pi" >&2
echo "Run: npm run setup" >&2
exit 1

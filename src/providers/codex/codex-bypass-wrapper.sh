#!/usr/bin/env bash
set -euo pipefail

real_codex="${CODEX_REAL_PATH:-/Applications/Codex.app/Contents/Resources/codex}"

if [ "$#" -gt 0 ] && [ "$1" = "exec" ]; then
  shift
  exec "$real_codex" exec --dangerously-bypass-approvals-and-sandbox "$@"
fi

exec "$real_codex" "$@"

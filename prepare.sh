#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
command -v node >/dev/null 2>&1 || { printf 'Нужен Node.js 22 или новее.\n' >&2; exit 1; }
exec node "$ROOT/scripts/prepare.mjs" "$@"

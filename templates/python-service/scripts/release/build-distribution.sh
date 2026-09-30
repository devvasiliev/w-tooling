#!/usr/bin/env bash

# Тонкая обвязка оператора: выбирает канонический сборщик перед упаковкой.

set -euo pipefail
IFS=$'\n\t'
export LC_ALL=C
umask 077

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
source "${SCRIPT_DIR}/native-buildkit.sh"

for required_command in git docker python3 gzip tar; do
  command -v "$required_command" >/dev/null 2>&1 || {
    printf 'ERROR: %s не найден\n' "$required_command" >&2
    exit 1
  }
done

project_release_select_native_buildkit
exec python3 "${SCRIPT_DIR}/build_distribution.py" "$@"

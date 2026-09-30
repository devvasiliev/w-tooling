#!/usr/bin/env bash
# Воспроизводимая точка входа модульных и контрактных тестов на зафиксированных зависимостях.

set -euo pipefail

repository_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repository_root"

if [[ "$(uname -s)" != "Linux" ]]; then
  echo "Полный test-контур требует Linux; запуск через Docker test-stage."
  exec make test-docker
fi

python_command="${W_TEST_PYTHON:-python3.12}"
venv_path="$repository_root/.venv"
fingerprint_path="$venv_path/.task-test-lock.sha256"

if ! command -v "$python_command" >/dev/null 2>&1; then
  echo "Python 3.12 не найден: установи его или задай W_TEST_PYTHON." >&2
  exit 1
fi

python_version="$($python_command -c 'import sys; print(f"{sys.version_info.major}.{sys.version_info.minor}")')"
if [[ "$python_version" != "3.12" ]]; then
  echo "Для тестов требуется Python 3.12, получен $python_version." >&2
  exit 1
fi

lock_fingerprint="$($python_command -c 'import hashlib, pathlib; digest = hashlib.sha256(); [digest.update(pathlib.Path(name).read_bytes()) for name in ("requirements-build.lock", "requirements-dev.lock")]; print(digest.hexdigest())')"

if [[ ! -x "$venv_path/bin/python" ]] || [[ "$($venv_path/bin/python -c 'import sys; print(f"{sys.version_info.major}.{sys.version_info.minor}")' 2>/dev/null || true)" != "3.12" ]]; then
  "$python_command" -m venv --clear "$venv_path"
fi

installed_fingerprint=""
if [[ -f "$fingerprint_path" ]]; then
  installed_fingerprint="$(<"$fingerprint_path")"
fi
if [[ "$installed_fingerprint" != "$lock_fingerprint" ]]; then
  "$venv_path/bin/python" -m pip install \
    --disable-pip-version-check \
    --require-hashes \
    --requirement "$repository_root/requirements-build.lock"
  "$venv_path/bin/python" -m pip install \
    --disable-pip-version-check \
    --require-hashes \
    --requirement "$repository_root/requirements-dev.lock"
  printf '%s\n' "$lock_fingerprint" > "$fingerprint_path"
fi

"$venv_path/bin/python" -m pip install \
  --disable-pip-version-check \
  --no-build-isolation \
  --no-deps \
  --editable .

export PATH="$venv_path/bin:$PATH"
export MYPY_CACHE_DIR="${MYPY_CACHE_DIR:-$venv_path/.mypy-cache}"
export PYTHONPYCACHEPREFIX="${PYTHONPYCACHEPREFIX:-$venv_path/.python-cache}"
export RUFF_CACHE_DIR="${RUFF_CACHE_DIR:-$venv_path/.ruff-cache}"

exec "$venv_path/bin/python" -m unittest discover -s tests -v "$@"

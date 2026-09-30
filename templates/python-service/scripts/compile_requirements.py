"""Собирает воспроизводимые lock-файлы зависимостей в изолированном контейнере."""

from __future__ import annotations

import os
import subprocess
from pathlib import Path

PYTHON_IMAGE = (
    "python:3.12.14-slim-bookworm@"
    "sha256:a116514e19457bcb7af7efe9c3dd0b9b71e85b317694e7882a1c52aa15a78134"
)
LOCK_TARGETS = (
    ("requirements/build.in", "requirements-build.lock"),
    ("requirements/runtime.in", "requirements.lock"),
    ("requirements/test.in", "requirements-test.lock"),
    ("requirements/dev.in", "requirements-dev.lock"),
)


def _container_script() -> str:
    """Собирает shell-сценарий двухфазной компиляции и проверки lock-файлов."""

    compile_commands = "\n".join(
        f'compile "{source}" "{target}" "{target}"' for source, target in LOCK_TARGETS
    )
    return f"""
set -eu
python -m venv /tmp/lock-bootstrap
/tmp/lock-bootstrap/bin/python -m pip install \\
  --no-cache-dir \\
  --require-hashes \\
  --requirement requirements-lock-tool.lock
cp requirements-lock-tool.lock /tmp/requirements-lock-tool.lock
/tmp/lock-bootstrap/bin/python -m piptools compile \\
  --allow-unsafe \\
  --generate-hashes \\
  --no-emit-index-url \\
  --no-emit-trusted-host \\
  --no-strip-extras \\
  --quiet \\
  --resolver=backtracking \\
  --reuse-hashes \\
  --output-file=/tmp/requirements-lock-tool.lock \\
  requirements/lock-tool.in

python -m venv /tmp/lock-compiler
/tmp/lock-compiler/bin/python -m pip install \\
  --no-cache-dir \\
  --require-hashes \\
  --requirement /tmp/requirements-lock-tool.lock

cp /tmp/requirements-lock-tool.lock /tmp/requirements-lock-tool.verify.lock
/tmp/lock-compiler/bin/python -m piptools compile \\
  --allow-unsafe \\
  --generate-hashes \\
  --no-emit-index-url \\
  --no-emit-trusted-host \\
  --no-strip-extras \\
  --quiet \\
  --resolver=backtracking \\
  --reuse-hashes \\
  --output-file=/tmp/requirements-lock-tool.verify.lock \\
  requirements/lock-tool.in
cmp /tmp/requirements-lock-tool.lock /tmp/requirements-lock-tool.verify.lock
cp /tmp/requirements-lock-tool.verify.lock requirements-lock-tool.lock

compile() {{
  output="/tmp/$(basename "$2")"
  if [ -f "$3" ]; then
    cp "$3" "$output"
  else
    rm -f "$output"
  fi
  /tmp/lock-compiler/bin/python -m piptools compile \\
    --allow-unsafe \\
    --generate-hashes \\
    --no-emit-index-url \\
    --no-emit-trusted-host \\
    --no-strip-extras \\
    --quiet \\
    --resolver=backtracking \\
    --reuse-hashes \\
    --output-file="$output" \\
    "$1"
  cp "$output" "$2"
}}

{compile_commands}
"""


def main() -> int:
    root = Path(__file__).resolve().parents[1]
    command = [
        "docker",
        "run",
        "--rm",
        "--user",
        f"{os.getuid()}:{os.getgid()}",
        "--env",
        "HOME=/tmp",
        "--env",
        "PIP_DISABLE_PIP_VERSION_CHECK=1",
        "--env",
        "CUSTOM_COMPILE_COMMAND=python scripts/compile_requirements.py",
        "--volume",
        f"{root}:/work",
        "--workdir",
        "/work",
        PYTHON_IMAGE,
        "sh",
        "-c",
        _container_script(),
    ]
    return subprocess.run(command, check=False).returncode


if __name__ == "__main__":
    raise SystemExit(main())

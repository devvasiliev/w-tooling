"""Запускает выбранный набор stateful-тестов с кратким итогом для человека."""

from __future__ import annotations

import os
import re
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MODULES_FILE = ROOT / "tests" / "stateful-modules.txt"
MODULE_PATTERN = re.compile(r"^tests\.integration\.test_[a-z0-9_]+$")


def configured_modules() -> list[str]:
    modules: list[str] = []
    for raw in MODULES_FILE.read_text(encoding="utf-8").splitlines():
        module = raw.partition("#")[0].strip()
        if not module:
            continue
        if not MODULE_PATTERN.fullmatch(module):
            raise ValueError(f"Недопустимый stateful module: {module}")
        path = ROOT / f"{module.replace('.', '/')}.py"
        if not path.is_file():
            raise ValueError(f"Stateful module не найден: {path}")
        modules.append(module)
    if not modules:
        raise ValueError(f"{MODULES_FILE} не содержит stateful modules")
    if len(modules) != len(set(modules)):
        raise ValueError(f"{MODULES_FILE} содержит дубликаты")
    return modules


def selected_tests(modules: list[str]) -> list[str]:
    selector = os.environ.get("W_STATEFUL_TEST", "").strip()
    if not selector:
        return modules
    if not any(selector == module or selector.startswith(f"{module}.") for module in modules):
        raise ValueError(f"Тест не входит в stateful suite: {selector}")
    return [selector]


def main() -> int:
    try:
        modules = configured_modules()
        names = selected_tests(modules)
    except (OSError, ValueError) as error:
        print(error, file=sys.stderr)
        return 2

    suite = unittest.defaultTestLoader.loadTestsFromNames(names)
    result = unittest.TextTestRunner(verbosity=2).run(suite)
    if result.testsRun == 0:
        print("Stateful suite не выполнил ни одного теста.", file=sys.stderr)
        return 2
    if result.skipped:
        print("Stateful suite содержит пропущенные тесты:", file=sys.stderr)
        for test, reason in result.skipped:
            print(f"- {test}: {reason}", file=sys.stderr)
        return 2
    return 0 if result.wasSuccessful() else 1


if __name__ == "__main__":
    raise SystemExit(main())

from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from scripts.check_dependency_locks import (
    LockParseErrorCode,
    check,
    is_sibling_service_dependency,
    parse_lock,
)

ROOT = Path(__file__).resolve().parents[2]


class DependencyLocksTest(unittest.TestCase):
    def test_generated_locks_are_complete_hashed_and_consistent(self) -> None:
        self.assertEqual(check(ROOT), [])

    def test_generated_lock_rejects_indexes_and_nested_includes(self) -> None:
        for option in ("  --index-url https://example.invalid/simple", "-r requirements.lock"):
            with self.subTest(option=option), tempfile.TemporaryDirectory() as directory:
                path = Path(directory) / "requirements.lock"
                path.write_text(f"{option}\n", encoding="utf-8")

                _requirements, errors = parse_lock(path)

                self.assertIn(
                    LockParseErrorCode.FORBIDDEN_GENERATED_OPTION,
                    [error.code for error in errors],
                )

    def test_sibling_service_distribution_is_rejected(self) -> None:
        self.assertTrue(is_sibling_service_dependency("task-other", "task-sample"))
        self.assertFalse(is_sibling_service_dependency("task-sample", "task-sample"))
        self.assertFalse(is_sibling_service_dependency("fastapi", "task-sample"))


if __name__ == "__main__":
    unittest.main()

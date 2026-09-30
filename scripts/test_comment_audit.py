"""Регрессия механического аудита комментариев Python-кода."""

from __future__ import annotations

import importlib.util
import sys
import tempfile
import unittest
from pathlib import Path

SCRIPT = (
    Path(__file__).resolve().parents[1]
    / ".codex/skills/code-comments/scripts/audit_python_comments.py"
)
SPEC = importlib.util.spec_from_file_location("audit_python_comments", SCRIPT)
assert SPEC is not None and SPEC.loader is not None
AUDIT = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = AUDIT
SPEC.loader.exec_module(AUDIT)


class CommentAuditTest(unittest.TestCase):
    """Проверяет стабильную классификацию нарушений без сравнения текста диагностики."""

    def audit_source(self, source: str, *, threshold: int = 10):
        """Запускает аудит одного временного модуля и возвращает типизированный итог."""

        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "sample.py"
            path.write_text(source, encoding="utf-8")
            return AUDIT.audit([path], large_function_lines=threshold)

    def test_reports_missing_template_and_non_russian_public_docstrings(self) -> None:
        """Различает отсутствие, пустой шаблон и документацию без русского текста."""

        result = self.audit_source(
            '''
def missing():
    return None

def template():
    """Выполняет template."""
    return None

def english():
    """Returns a value."""
    return None
'''
        )

        self.assertEqual(
            {finding.code for finding in result.errors},
            {
                "PUBLIC_DOCSTRING_MISSING",
                "DOCSTRING_IS_TEMPLATE",
                "DOCSTRING_IS_NOT_RUSSIAN",
            },
        )

    def test_large_function_is_only_a_review_candidate(self) -> None:
        """Оставляет большую функцию кандидатом на ручной просмотр, а не ошибкой."""

        result = self.audit_source(
            '''
def process():
    """Возвращает собранный результат."""
    first = 1
    second = 2
    third = 3
    fourth = 4
    fifth = 5
    sixth = 6
    seventh = 7
    return first + second + third + fourth + fifth + sixth + seventh
'''
        )

        self.assertEqual(result.errors, ())
        self.assertEqual([finding.code for finding in result.warnings], [
            "LARGE_FUNCTION_NEEDS_REVIEW"
        ])

    def test_reports_infinitive_docstring_as_a_stable_error_code(self) -> None:
        """Возвращает стабильный код причины для docstring, начатого с инфинитива."""

        result = self.audit_source(
            '''
def build_result():
    """Собрать итог для вызывающего кода."""
    return None
'''
        )

        self.assertEqual(
            [finding.code for finding in result.errors],
            ["DOCSTRING_STARTS_WITH_INFINITIVE"],
        )

    def test_local_reason_comment_satisfies_large_function_navigation_check(self) -> None:
        """Не помечает большую функцию, когда локальный комментарий объясняет причину."""

        result = self.audit_source(
            '''
def process():
    """Возвращает собранный результат."""
    first = 1
    second = 2
    third = 3
    # Порядок нужен для совместимости с предыдущей версией формата.
    fourth = 4
    fifth = 5
    sixth = 6
    seventh = 7
    return first + second + third + fourth + fifth + sixth + seventh
'''
        )

        self.assertEqual(result.errors, ())
        self.assertEqual(result.warnings, ())


if __name__ == "__main__":
    unittest.main()

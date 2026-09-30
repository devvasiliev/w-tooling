#!/usr/bin/env python3
"""Находит механические дефекты комментариев в Python-коде."""

from __future__ import annotations

import argparse
import ast
import io
import re
import tokenize
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable, Sequence

INFINITIVE_START = re.compile(
    r"^(?:Не\s+)?[А-ЯЁа-яё-]+(?:ть|ти|чь)(?:\s|[.,:;!?])"
)
EMPTY_START = re.compile(
    r"^(?:Выполняет|Описывает|Реализует|Проверяет обязательное значение для)"
    r"(?:\s|[.,:;!?])"
)
CYRILLIC = re.compile(r"[А-Яа-яЁё]")
IGNORED_COMMENT_PREFIXES = ("#!", "# noqa", "# type:", "# pragma:")


@dataclass(frozen=True, order=True)
class Finding:
    """Описывает одно нарушение или место для содержательного ручного ревью."""

    path: Path
    line: int
    severity: str
    code: str
    message: str


@dataclass(frozen=True)
class AuditResult:
    """Содержит полный итог одного детерминированного запуска аудита."""

    files: int
    documented_points: int
    comments: int
    findings: tuple[Finding, ...]

    @property
    def errors(self) -> tuple[Finding, ...]:
        """Возвращает нарушения, для которых не требуется смысловое решение."""

        return tuple(item for item in self.findings if item.severity == "ERROR")

    @property
    def warnings(self) -> tuple[Finding, ...]:
        """Возвращает большие функции, которые необходимо прочитать вручную."""

        return tuple(item for item in self.findings if item.severity == "WARNING")


def python_files(roots: Sequence[Path]) -> tuple[Path, ...]:
    """Разворачивает файлы и каталоги в стабильный набор Python-модулей."""

    files: set[Path] = set()
    for root in roots:
        if root.is_file() and root.suffix == ".py":
            files.add(root)
        elif root.is_dir():
            files.update(path for path in root.rglob("*.py") if path.is_file())
        else:
            raise FileNotFoundError(f"путь аудита не найден: {root}")
    return tuple(sorted(files))


def ordinary_comment_lines(source: str) -> frozenset[int]:
    """Возвращает строки смысловых комментариев без директив инструментов."""

    lines: set[int] = set()
    for token in tokenize.generate_tokens(io.StringIO(source).readline):
        if token.type != tokenize.COMMENT:
            continue
        value = token.string.strip()
        if value.startswith(IGNORED_COMMENT_PREFIXES):
            continue
        lines.add(token.start[0])
    return frozenset(lines)


def selected_documentation_point(
    node: ast.FunctionDef | ast.AsyncFunctionDef,
    parent: ast.AST | None,
) -> bool:
    """Выбирает публичную функцию или любой метод, кроме конструктора."""

    is_method = isinstance(parent, ast.ClassDef) and node.name != "__init__"
    is_public_function = isinstance(parent, ast.Module) and not node.name.startswith("_")
    return is_method or is_public_function


def audit_file(path: Path, *, large_function_lines: int) -> tuple[int, int, list[Finding]]:
    """Проверяет один модуль и возвращает счётчики вместе с точными находками."""

    source = path.read_text(encoding="utf-8")
    try:
        tree = ast.parse(source)
    except SyntaxError as error:
        return 0, 0, [
            Finding(
                path,
                error.lineno or 1,
                "ERROR",
                "PYTHON_PARSE_ERROR",
                error.msg,
            )
        ]
    # Python AST не хранит ссылку на родителя. Карта позволяет отличить метод
    # класса от вложенной функции без догадок по имени или уровню отступа.
    parents = {
        child: parent
        for parent in ast.walk(tree)
        for child in ast.iter_child_nodes(parent)
    }
    comment_lines = ordinary_comment_lines(source)
    findings: list[Finding] = []
    documented_points = 0

    for node in ast.walk(tree):
        if not isinstance(node, ast.FunctionDef | ast.AsyncFunctionDef):
            continue
        documentation = ast.get_docstring(node)
        if selected_documentation_point(node, parents.get(node)):
            location = f"{node.name}"
            if documentation is None:
                findings.append(
                    Finding(
                        path,
                        node.lineno,
                        "ERROR",
                        "PUBLIC_DOCSTRING_MISSING",
                        f"у точки {location} отсутствует docstring",
                    )
                )
            else:
                documented_points += 1
                if INFINITIVE_START.match(documentation):
                    findings.append(
                        Finding(
                            path,
                            node.lineno,
                            "ERROR",
                            "DOCSTRING_STARTS_WITH_INFINITIVE",
                            f"docstring {location} начинается с инфинитива",
                        )
                    )
                if EMPTY_START.match(documentation):
                    findings.append(
                        Finding(
                            path,
                            node.lineno,
                            "ERROR",
                            "DOCSTRING_IS_TEMPLATE",
                            f"docstring {location} начинается с пустого шаблона",
                        )
                    )
                if CYRILLIC.search(documentation) is None:
                    findings.append(
                        Finding(
                            path,
                            node.lineno,
                            "ERROR",
                            "DOCSTRING_IS_NOT_RUSSIAN",
                            f"docstring {location} не содержит русского текста",
                        )
                    )

        end_line = node.end_lineno or node.lineno
        line_count = end_line - node.lineno + 1
        has_local_comment = any(node.lineno < line <= end_line for line in comment_lines)
        has_detailed_docstring = documentation is not None and (
            "\n" in documentation or len(documentation) >= 120
        )
        # Размер функции сам по себе не является дефектом. Кандидат попадает в
        # отчёт, только когда рядом нет ни объяснения нюанса, ни развёрнутого
        # docstring; окончательное решение всё равно принимает разработчик.
        if (
            line_count >= large_function_lines
            and not has_local_comment
            and not has_detailed_docstring
        ):
            findings.append(
                Finding(
                    path,
                    node.lineno,
                    "WARNING",
                    "LARGE_FUNCTION_NEEDS_REVIEW",
                    (
                        f"функция {node.name} занимает {line_count} строк; проверь, "
                        "объяснены ли внутри неочевидные причины и гарантии"
                    ),
                )
            )

    return documented_points, len(comment_lines), findings


def audit(roots: Sequence[Path], *, large_function_lines: int = 45) -> AuditResult:
    """Проверяет указанные корни и собирает один человекочитаемый итог."""

    if large_function_lines < 10:
        raise ValueError("порог большой функции должен быть не меньше 10 строк")
    files = python_files(roots)
    documented_points = 0
    comments = 0
    findings: list[Finding] = []
    for path in files:
        file_points, file_comments, file_findings = audit_file(
            path,
            large_function_lines=large_function_lines,
        )
        documented_points += file_points
        comments += file_comments
        findings.extend(file_findings)
    return AuditResult(
        files=len(files),
        documented_points=documented_points,
        comments=comments,
        findings=tuple(sorted(findings)),
    )


def render(result: AuditResult, *, relative_to: Path) -> str:
    """Формирует основной отчёт с причиной и точным следующим шагом."""

    lines = []
    for finding in result.findings:
        try:
            path = finding.path.resolve().relative_to(relative_to.resolve())
        except ValueError:
            path = finding.path
        lines.append(
            f"{finding.severity} {finding.code} {path}:{finding.line}: {finding.message}"
        )
    lines.append(
        "Python comments audit: "
        f"files={result.files}, documented_points={result.documented_points}, "
        f"comments={result.comments}, errors={len(result.errors)}, "
        f"review_candidates={len(result.warnings)}."
    )
    if result.errors:
        lines.append("Next: исправь ERROR и повтори ту же команду.")
    elif result.warnings:
        lines.append("Next: вручную проверь WARNING; они не означают дефект автоматически.")
    else:
        lines.append("Next: механических нарушений нет; заверши смысловое ревью терминов.")
    return "\n".join(lines)


def parse_args(arguments: Iterable[str] | None = None) -> argparse.Namespace:
    """Разбирает корни аудита и настраиваемый порог большой функции."""

    parser = argparse.ArgumentParser()
    parser.add_argument("roots", nargs="+", type=Path)
    parser.add_argument("--large-function-lines", type=int, default=45)
    parser.add_argument("--fail-on-warnings", action="store_true")
    return parser.parse_args(arguments)


def main(arguments: Iterable[str] | None = None) -> int:
    """Печатает итог и возвращает ненулевой код только для выбранных нарушений."""

    args = parse_args(arguments)
    try:
        result = audit(args.roots, large_function_lines=args.large_function_lines)
    except (OSError, ValueError) as error:
        print(f"Python comments audit failed: {error}")
        return 2
    print(render(result, relative_to=Path.cwd()))
    if result.errors or (args.fail_on_warnings and result.warnings):
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

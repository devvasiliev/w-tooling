"""Проверяет допустимые зависимости архитектурных слоёв Python-пакета."""

from __future__ import annotations

import argparse
import ast
import sys
from dataclasses import dataclass
from pathlib import Path

LAYER_ORDER = {
    "domain": 0,
    "application": 1,
    "adapters": 2,
    "bootstrap": 3,
}
INNER_LAYERS = frozenset({"domain", "application"})
STDLIB_MODULES = frozenset(sys.stdlib_module_names)


@dataclass(frozen=True)
class Violation:
    path: Path
    line: int
    dependency: str
    reason: str


def _module_context(path: Path, package_root: Path, package: str) -> str:
    relative = path.relative_to(package_root).with_suffix("")
    parts = list(relative.parts)
    if parts:
        parts.pop()
    return ".".join((package, *parts))


def _resolve_relative(module: str | None, level: int, context: str, alias: str) -> str:
    base = context.split(".")
    ascend = level - 1
    if ascend >= len(base):
        return "." * level + (module or alias)
    resolved = base[: len(base) - ascend]
    if module:
        resolved.extend(module.split("."))
    else:
        resolved.append(alias)
    return ".".join(resolved)


def imported_modules(
    tree: ast.AST,
    path: Path,
    package_root: Path,
    package: str,
) -> list[tuple[int, str]]:
    context = _module_context(path, package_root, package)
    result: list[tuple[int, str]] = []
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            result.extend((node.lineno, alias.name) for alias in node.names)
        elif isinstance(node, ast.ImportFrom) and node.level:
            result.extend(
                (
                    node.lineno,
                    _resolve_relative(node.module, node.level, context, alias.name),
                )
                for alias in node.names
            )
        elif isinstance(node, ast.ImportFrom) and node.module:
            result.append((node.lineno, node.module))
    return result


def unsafe_runtime_references(tree: ast.AST) -> list[tuple[int, str, str]]:
    """Находит строковые пути и динамические импорты, обходящие границы слоёв."""

    result: list[tuple[int, str, str]] = []
    for node in ast.walk(tree):
        if isinstance(node, ast.Constant) and isinstance(node.value, str):
            if "../task-" in node.value or "..\\task-" in node.value:
                result.append(
                    (node.lineno, node.value, "путь соседнего сервиса запрещён при запуске")
                )
        if not isinstance(node, ast.Call):
            continue
        if isinstance(node.func, ast.Name) and node.func.id == "__import__":
            result.append((node.lineno, "__import__", "dynamic imports bypass layer checks"))
        if (
            isinstance(node.func, ast.Attribute)
            and node.func.attr == "import_module"
            and isinstance(node.func.value, ast.Name)
            and node.func.value.id == "importlib"
        ):
            result.append(
                (
                    node.lineno,
                    "importlib.import_module",
                    "dynamic imports bypass layer checks",
                )
            )
        if (
            isinstance(node.func, ast.Attribute)
            and node.func.attr in {"append", "extend", "insert"}
            and isinstance(node.func.value, ast.Attribute)
            and node.func.value.attr == "path"
            and isinstance(node.func.value.value, ast.Name)
            and node.func.value.value.id == "sys"
        ):
            result.append((node.lineno, "sys.path", "подмена пути при запуске запрещена"))
    return result


def layer_for(path: Path, package_root: Path) -> str | None:
    relative = path.relative_to(package_root)
    layer = relative.parts[0] if len(relative.parts) > 1 else None
    return layer if layer in LAYER_ORDER else None


def dependency_violation(layer: str | None, dependency: str, package: str) -> str | None:
    top = dependency.split(".", 1)[0]
    parts = dependency.split(".")
    dependency_layer = parts[1] if top == package and len(parts) > 1 else None

    if top.startswith("project_") and top != package:
        return "runtime import from another W service"

    if layer is None:
        return None

    if top == package:
        if dependency_layer in LAYER_ORDER and LAYER_ORDER[dependency_layer] > LAYER_ORDER[layer]:
            if layer == "domain":
                return "domain may import only its own domain"
            if layer == "application":
                return "application may not import outer layers"
            return "adapters may not import bootstrap"
        return None

    if layer in INNER_LAYERS and top not in STDLIB_MODULES:
        if layer == "domain":
            return "domain may use only the standard library"
        return "application may use only domain, local ports and standard library"
    return None


def check_repository(root: Path, package: str) -> list[Violation]:
    package_root = root / "src" / package
    if not package_root.is_dir():
        raise ValueError(f"каталог пакета не найден: {package_root}")

    violations: list[Violation] = []
    for path in sorted(package_root.rglob("*.py")):
        tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
        layer = layer_for(path, package_root)
        for line, dependency in imported_modules(tree, path, package_root, package):
            reason = dependency_violation(layer, dependency, package)
            if reason is not None:
                violations.append(Violation(path, line, dependency, reason))
        for line, dependency, reason in unsafe_runtime_references(tree):
            violations.append(Violation(path, line, dependency, reason))
    return violations


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", type=Path, default=Path.cwd())
    parser.add_argument("--package", required=True)
    args = parser.parse_args()
    violations = check_repository(args.root.resolve(), args.package)
    for item in violations:
        print(
            f"{item.path}:{item.line}: architecture violation {item.dependency}: {item.reason}",
            file=sys.stderr,
        )
    return 1 if violations else 0


if __name__ == "__main__":
    raise SystemExit(main())

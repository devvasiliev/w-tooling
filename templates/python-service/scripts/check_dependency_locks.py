"""Проверяет полноту, хеши и согласованность lock-файлов зависимостей."""

from __future__ import annotations

import re
import sys
import tomllib
from collections.abc import Iterable
from dataclasses import dataclass
from enum import StrEnum
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
LOCK_INPUTS = {
    "requirements-lock-tool.lock": "requirements/lock-tool.in",
    "requirements-build.lock": "requirements/build.in",
    "requirements.lock": "requirements/runtime.in",
    "requirements-test.lock": "requirements/test.in",
    "requirements-dev.lock": "requirements/dev.in",
}
PIN = re.compile(
    r"^(?P<name>[A-Za-z0-9_.-]+)(?:\[(?P<extras>[A-Za-z0-9_,.-]+)\])?"
    r"==(?P<version>[^\s;\\]+)(?:\s*;\s*[^\\]+)?\s*\\$"
)
HASH = re.compile(r"^--hash=sha256:[0-9a-f]{64}(?:\s*\\)?$")
INPUT_PIN = re.compile(r"^(?P<name>[A-Za-z0-9_.-]+)(?:\[[A-Za-z0-9_,.-]+\])?==(?P<version>[^\s]+)$")


def canonical_name(value: str) -> str:
    return re.sub(r"[-_.]+", "-", value).lower()


def is_sibling_service_dependency(name: str, own_distribution: str) -> bool:
    return name.startswith("task-") and name != own_distribution


@dataclass(frozen=True)
class LockedRequirement:
    name: str
    version: str
    hashes: tuple[str, ...]


class LockParseErrorCode(StrEnum):
    """Классифицирует нарушения формата lock-файла независимо от текста диагностики."""

    FORBIDDEN_GENERATED_OPTION = "forbidden_generated_option"
    UNSTABLE_COMPILER_ENVIRONMENT = "unstable_compiler_environment"
    INVALID_PIN = "invalid_pin"
    INVALID_HASH_CONTINUATION = "invalid_hash_continuation"
    MISSING_HASH = "missing_hash"
    DUPLICATE_DISTRIBUTION = "duplicate_distribution"


@dataclass(frozen=True)
class LockParseError:
    """Хранит стабильную причину нарушения и его русскую диагностику."""

    code: LockParseErrorCode
    message: str

    def __str__(self) -> str:
        """Возвращает человекочитаемую диагностику для CLI."""

        return self.message


def logical_lines(path: Path) -> Iterable[tuple[int, list[str]]]:
    current: list[str] = []
    start = 0
    for number, raw_line in enumerate(path.read_text(encoding="utf-8").splitlines(), start=1):
        stripped = raw_line.strip()
        if not stripped or stripped.startswith("#"):
            continue
        if not current:
            start = number
        current.append(stripped)
        if not stripped.endswith("\\"):
            yield start, current
            current = []
    if current:
        yield start, current


def parse_lock(path: Path) -> tuple[dict[str, LockedRequirement], list[LockParseError]]:
    """Разбирает lock-файл и собирает все нарушения его воспроизводимого формата."""

    requirements: dict[str, LockedRequirement] = {}
    errors: list[LockParseError] = []
    source = path.read_text(encoding="utf-8")
    for forbidden in (
        "--index-url",
        "--extra-index-url",
        "--trusted-host",
        "-r",
        "-c",
    ):
        if re.search(rf"^\s*{re.escape(forbidden)}(?:\s|$)", source, flags=re.MULTILINE):
            errors.append(
                LockParseError(
                    code=LockParseErrorCode.FORBIDDEN_GENERATED_OPTION,
                    message=(
                        f"{path.name}: запрещённая сгенерированная опция {forbidden!r}"
                    ),
                )
            )
    if "CUSTOM_COMPILE_COMMAND" in source:
        errors.append(
            LockParseError(
                code=LockParseErrorCode.UNSTABLE_COMPILER_ENVIRONMENT,
                message=(
                    f"{path.name}: нестабильное окружение компилятора попало в lock"
                ),
            )
        )

    for number, lines in logical_lines(path):
        match = PIN.fullmatch(lines[0])
        if match is None:
            errors.append(
                LockParseError(
                    code=LockParseErrorCode.INVALID_PIN,
                    message=(
                        f"{path.name}:{number}: ожидалась точная == версия "
                        "с продолжениями hash"
                    ),
                )
            )
            continue
        hashes: list[str] = []
        for offset, line in enumerate(lines[1:], start=1):
            if HASH.fullmatch(line) is None:
                errors.append(
                    LockParseError(
                        code=LockParseErrorCode.INVALID_HASH_CONTINUATION,
                        message=(
                            f"{path.name}:{number + offset}: "
                            "недействительное продолжение hash sha256"
                        ),
                    )
                )
                continue
            hashes.append(line.removesuffix("\\").strip().removeprefix("--hash=sha256:"))
        if not hashes:
            errors.append(
                LockParseError(
                    code=LockParseErrorCode.MISSING_HASH,
                    message=f"{path.name}:{number}: зависимость не содержит hash sha256",
                )
            )
        name = canonical_name(match.group("name"))
        if name in requirements:
            errors.append(
                LockParseError(
                    code=LockParseErrorCode.DUPLICATE_DISTRIBUTION,
                    message=f"{path.name}:{number}: distribution {name} дублируется",
                )
            )
        requirements[name] = LockedRequirement(
            name=name,
            version=match.group("version"),
            hashes=tuple(sorted(hashes)),
        )
    return requirements, errors


def direct_input_pins(path: Path, seen: set[Path] | None = None) -> dict[str, str]:
    visited = seen or set()
    resolved = path.resolve()
    if resolved in visited:
        raise ValueError(f"циклическое включение входного файла зависимостей: {path}")
    visited.add(resolved)
    pins: dict[str, str] = {}
    for number, raw_line in enumerate(path.read_text(encoding="utf-8").splitlines(), start=1):
        line = raw_line.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("-r "):
            pins.update(direct_input_pins(path.parent / line[3:].strip(), visited))
            continue
        match = INPUT_PIN.fullmatch(line)
        if match is None:
            raise ValueError(f"{path}:{number}: входные зависимости должны иметь точные == версии")
        pins[canonical_name(match.group("name"))] = match.group("version")
    visited.remove(resolved)
    return pins


def pyproject_pins(path: Path) -> dict[str, str]:
    project = tomllib.loads(path.read_text(encoding="utf-8"))
    pins: dict[str, str] = {}
    for dependency in project["project"]["dependencies"]:
        match = INPUT_PIN.fullmatch(dependency)
        if match is None:
            raise ValueError(
                f"{path}: зависимость проекта должна иметь точную == версию: {dependency}"
            )
        pins[canonical_name(match.group("name"))] = match.group("version")
    for requirement in project["build-system"]["requires"]:
        match = INPUT_PIN.fullmatch(requirement)
        if match is None:
            raise ValueError(
                f"{path}: зависимость сборки должна иметь точную == версию: {requirement}"
            )
    return pins


def check(root: Path = ROOT) -> list[str]:
    """Проверяет согласованность input, lock и pyproject-зависимостей проекта."""

    errors: list[str] = []
    locks: dict[str, dict[str, LockedRequirement]] = {}
    for lock_name, input_name in LOCK_INPUTS.items():
        lock_path = root / lock_name
        input_path = root / input_name
        if not lock_path.is_file():
            errors.append(f"отсутствует сгенерированный lock: {lock_name}")
            continue
        if not input_path.is_file():
            errors.append(f"отсутствует редактируемый человеком input: {input_name}")
            continue
        parsed, parse_errors = parse_lock(lock_path)
        locks[lock_name] = parsed
        errors.extend(str(error) for error in parse_errors)
        try:
            inputs = direct_input_pins(input_path)
        except ValueError as error:
            errors.append(str(error))
            continue
        for name, version in inputs.items():
            locked = parsed.get(name)
            if locked is None:
                errors.append(f"{lock_name}: отсутствует прямая входная зависимость {name}")
            elif locked.version != version:
                errors.append(
                    f"{lock_name}: прямая зависимость {name}=={version} "
                    f"разрешилась как {locked.version}"
                )

    runtime = locks.get("requirements.lock", {})
    build = locks.get("requirements-build.lock", {})
    try:
        project_path = root / "pyproject.toml"
        if not project_path.is_file():
            project_path = root / "pyproject.toml.tpl"
        project = tomllib.loads(project_path.read_text(encoding="utf-8"))
        own_distribution = canonical_name(project["project"]["name"])
        project_runtime = pyproject_pins(project_path)
        runtime_inputs = direct_input_pins(root / "requirements/runtime.in")
        if runtime_inputs != project_runtime:
            missing = sorted(set(project_runtime) - set(runtime_inputs))
            extra = sorted(set(runtime_inputs) - set(project_runtime))
            errors.append(
                "requirements/runtime.in должен совпадать с прямыми зависимостями PEP 621 "
                f"(отсутствуют={missing}, лишние={extra})"
            )
        for name, version in project_runtime.items():
            locked = runtime.get(name)
            if locked is None or locked.version != version:
                errors.append(
                    f"requirements.lock не соответствует версии pyproject {name}=={version}"
                )
        for name in runtime:
            if is_sibling_service_dependency(name, own_distribution):
                errors.append(
                    "requirements.lock: зависимость времени выполнения "
                    f"от другого W-сервиса: {name}"
                )
        build_inputs = direct_input_pins(root / "requirements/build.in")
        for requirement in project["build-system"]["requires"]:
            match = INPUT_PIN.fullmatch(requirement)
            assert match is not None
            name = canonical_name(match.group("name"))
            version = match.group("version")
            locked = build.get(name)
            if locked is None or locked.version != version:
                errors.append(
                    "requirements-build.lock не соответствует версии backend сборки "
                    f"{name}=={version}"
                )
            if build_inputs.get(name) != version:
                errors.append(
                    "requirements/build.in не соответствует версии backend сборки "
                    f"{name}=={version}"
                )
    except (KeyError, ValueError, tomllib.TOMLDecodeError) as error:
        errors.append(str(error))

    for smaller_name, larger_name in (
        ("requirements.lock", "requirements-test.lock"),
        ("requirements-test.lock", "requirements-dev.lock"),
    ):
        smaller = locks.get(smaller_name, {})
        larger = locks.get(larger_name, {})
        for name, requirement in smaller.items():
            inherited = larger.get(name)
            if inherited is None or inherited.version != requirement.version:
                errors.append(
                    f"{larger_name} должен содержать {name}=={requirement.version} "
                    f"из {smaller_name}"
                )
    return errors


def main() -> int:
    errors = check()
    for error in errors:
        print(f"нарушение фиксации зависимостей: {error}", file=sys.stderr)
    return 1 if errors else 0


if __name__ == "__main__":
    raise SystemExit(main())

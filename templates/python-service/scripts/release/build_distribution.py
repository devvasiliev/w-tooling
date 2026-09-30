#!/usr/bin/env python3
"""Собирает неизменяемый дистрибутив сервиса W по декларативному manifest."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
from dataclasses import dataclass
from pathlib import Path, PurePosixPath
from typing import Any, NoReturn, TextIO

PLATFORM = "linux/amd64"
CONFIG_PATH = PurePosixPath("scripts/release/distribution.json")
VERSION_PATTERN = re.compile(r"^[0-9]+\.[0-9]+\.[0-9]+(-?[a-z][a-z0-9]*([.-][a-z0-9]+)*)?$")
COMMIT_PATTERN = re.compile(r"^[0-9a-f]{40}$")
REQUIRED_PAYLOAD_TARGETS = frozenset(
    {
        "compatibility.json",
        "deploy.sh",
        "migration_manifest.py",
        "migrations/versions",
        "openapi.yaml",
        "verify_image_archive.py",
    }
)


class ReleaseBuildError(RuntimeError):
    """Детерминированный инвариант релиза не выполнен."""


@dataclass(frozen=True)
class PayloadEntry:
    source: PurePosixPath
    target: PurePosixPath
    executable: bool


@dataclass(frozen=True)
class ImageCommand:
    entrypoint: str
    arguments: tuple[str, ...]


@dataclass(frozen=True)
class DistributionConfig:
    distribution: str
    python_package: str
    image_repository: str
    test_image_repository: str
    required_image_files: tuple[str, ...]
    image_commands: tuple[ImageCommand, ...]
    payload: tuple[PayloadEntry, ...]


def fail(message: str) -> NoReturn:
    raise ReleaseBuildError(message)


def _object(value: Any, *, field: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        fail(f"{field} должен быть JSON object")
    return value


def _string(value: Any, *, field: str) -> str:
    if not isinstance(value, str) or not value:
        fail(f"{field} должен быть непустой строкой")
    return value


def _strict_keys(value: dict[str, Any], expected: set[str], *, field: str) -> None:
    actual = set(value)
    if actual != expected:
        missing = ", ".join(sorted(expected - actual)) or "нет"
        extra = ", ".join(sorted(actual - expected)) or "нет"
        fail(f"{field}: отсутствуют ключи [{missing}], лишние ключи [{extra}]")


def _relative_path(value: Any, *, field: str) -> PurePosixPath:
    text = _string(value, field=field)
    path = PurePosixPath(text)
    unsafe_part = any(part in {"", ".", ".."} for part in path.parts)
    if path.is_absolute() or text != path.as_posix() or unsafe_part:
        fail(f"{field} должен быть безопасным относительным POSIX-путём: {text}")
    return path


def load_config(path: Path) -> DistributionConfig:
    """Строго разбирает manifest дистрибутива и отвергает неявные значения."""

    try:
        document = _object(json.loads(path.read_text(encoding="utf-8")), field="manifest")
    except (OSError, json.JSONDecodeError) as error:
        fail(f"не удалось прочитать {path}: {error}")
    _strict_keys(
        document,
        {
            "schema_version",
            "distribution",
            "python_package",
            "image_repository",
            "test_image_repository",
            "required_image_files",
            "image_commands",
            "payload",
        },
        field="manifest",
    )
    if document["schema_version"] != 1:
        fail("поддерживается только schema_version=1")

    distribution = _string(document["distribution"], field="distribution")
    if not re.fullmatch(r"[a-z][a-z0-9]*(?:-[a-z0-9]+)*", distribution):
        fail("distribution должен быть в kebab-case")
    python_package = _string(document["python_package"], field="python_package")
    if not re.fullmatch(r"[a-z][a-z0-9_]*", python_package):
        fail("python_package должен быть допустимым именем Python")
    image_repository = _string(document["image_repository"], field="image_repository")
    test_image_repository = _string(
        document["test_image_repository"], field="test_image_repository"
    )
    repository_pattern = r"(?:[a-z0-9][a-z0-9.-]*(?::[0-9]+)?/)?[a-z0-9]+(?:[._/-][a-z0-9]+)*"
    for repository in (image_repository, test_image_repository):
        if not re.fullmatch(repository_pattern, repository):
            fail("image repository должен быть ссылкой registry/repository без тега")
    if image_repository == test_image_repository:
        fail("runtime и test image repositories должны различаться")

    required_image_files_document = document["required_image_files"]
    if not isinstance(required_image_files_document, list) or not required_image_files_document:
        fail("required_image_files должен быть непустым массивом")
    required_image_files: list[str] = []
    for index, value in enumerate(required_image_files_document):
        image_path = _string(value, field=f"required_image_files[{index}]")
        if not image_path.startswith("/app/") or ".." in PurePosixPath(image_path).parts:
            fail(f"required_image_files[{index}] должен находиться внутри /app")
        required_image_files.append(image_path)
    if len(set(required_image_files)) != len(required_image_files):
        fail("required_image_files содержит дубли")

    image_commands_document = document["image_commands"]
    if not isinstance(image_commands_document, list):
        fail("image_commands должен быть массивом")
    image_commands: list[ImageCommand] = []
    for index, value in enumerate(image_commands_document):
        command = _object(value, field=f"image_commands[{index}]")
        _strict_keys(command, {"entrypoint", "arguments"}, field=f"image_commands[{index}]")
        arguments_document = command["arguments"]
        if not isinstance(arguments_document, list):
            fail(f"image_commands[{index}].arguments должен быть массивом")
        arguments = tuple(
            _string(argument, field=f"image_commands[{index}].arguments[{argument_index}]")
            for argument_index, argument in enumerate(arguments_document)
        )
        image_commands.append(
            ImageCommand(
                entrypoint=_string(
                    command["entrypoint"], field=f"image_commands[{index}].entrypoint"
                ),
                arguments=arguments,
            )
        )

    payload_document = document["payload"]
    if not isinstance(payload_document, list) or not payload_document:
        fail("payload должен быть непустым массивом")
    payload: list[PayloadEntry] = []
    targets: set[PurePosixPath] = set()
    for index, value in enumerate(payload_document):
        entry = _object(value, field=f"payload[{index}]")
        allowed_keys = {"source", "target", "executable"}
        if not set(entry).issubset(allowed_keys) or not {"source", "target"}.issubset(entry):
            fail(f"payload[{index}] содержит неверный набор ключей")
        source = _relative_path(entry["source"], field=f"payload[{index}].source")
        target = _relative_path(entry["target"], field=f"payload[{index}].target")
        executable = entry.get("executable", False)
        if not isinstance(executable, bool):
            fail(f"payload[{index}].executable должен быть boolean")
        if target in targets:
            fail(f"payload содержит повторный target: {target}")
        if any(target in existing.parents or existing in target.parents for existing in targets):
            fail(f"payload содержит пересекающиеся targets: {target}")
        targets.add(target)
        payload.append(PayloadEntry(source=source, target=target, executable=executable))

    missing_targets = REQUIRED_PAYLOAD_TARGETS - {path.as_posix() for path in targets}
    if missing_targets:
        fail(f"payload не содержит обязательные targets: {', '.join(sorted(missing_targets))}")

    return DistributionConfig(
        distribution=distribution,
        python_package=python_package,
        image_repository=image_repository,
        test_image_repository=test_image_repository,
        required_image_files=tuple(required_image_files),
        image_commands=tuple(image_commands),
        payload=tuple(payload),
    )


def run(
    command: list[str],
    *,
    cwd: Path | None = None,
    capture_output: bool = False,
    stdout: TextIO | int | None = None,
) -> subprocess.CompletedProcess[str]:
    try:
        return subprocess.run(
            command,
            cwd=cwd,
            check=True,
            text=True,
            capture_output=capture_output,
            stdout=stdout,
        )
    except subprocess.CalledProcessError as error:
        fail(f"команда завершилась с кодом {error.returncode}: {' '.join(command)}")


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        while block := source.read(1024 * 1024):
            digest.update(block)
    return digest.hexdigest()


def normalize_source_tree(root: Path) -> None:
    for path in sorted(root.rglob("*")):
        if path.is_symlink():
            fail(f"accepted commit содержит символическую ссылку: {path.relative_to(root)}")
        if path.is_dir():
            path.chmod(0o755)
        elif path.is_file():
            executable = bool(path.stat().st_mode & 0o111)
            path.chmod(0o755 if executable else 0o644)
        else:
            fail(f"accepted commit содержит неподдерживаемый объект: {path.relative_to(root)}")


def copy_payload(source_root: Path, staging_root: Path, entry: PayloadEntry) -> None:
    source = source_root.joinpath(*entry.source.parts)
    target = staging_root.joinpath(*entry.target.parts)
    if source.is_symlink() or not source.exists():
        fail(f"payload source отсутствует либо является ссылкой: {entry.source}")
    if target.exists():
        fail(f"payload target уже существует: {entry.target}")
    target.parent.mkdir(parents=True, exist_ok=True)
    if source.is_file():
        shutil.copyfile(source, target)
        target.chmod(0o755 if entry.executable else 0o644)
        return
    if entry.executable:
        fail(f"директория payload не может быть executable: {entry.target}")
    if not source.is_dir():
        fail(f"payload source имеет неподдерживаемый тип: {entry.source}")
    for path in source.rglob("*"):
        if path.is_symlink():
            fail(f"payload source содержит символическую ссылку: {path.relative_to(source_root)}")
    shutil.copytree(source, target)
    for path in target.rglob("*"):
        path.chmod(0o755 if path.is_dir() else 0o644)


def save_image(image: str, output: Path) -> None:
    with output.open("wb") as destination:
        save = subprocess.Popen(["docker", "image", "save", image], stdout=subprocess.PIPE)
        if save.stdout is None:
            save.kill()
            fail("docker image save не предоставил stdout")
        gzip = subprocess.Popen(["gzip", "-n", "-9"], stdin=save.stdout, stdout=destination)
        save.stdout.close()
        gzip_result = gzip.wait()
        save_result = save.wait()
    if save_result != 0 or gzip_result != 0:
        fail(f"сохранение образа завершилось ошибкой: docker={save_result}, gzip={gzip_result}")


def write_checksums(staging_root: Path) -> None:
    checksum_path = staging_root / "SHA256SUMS"
    files = sorted(
        path for path in staging_root.rglob("*") if path.is_file() and path != checksum_path
    )
    if any(path.is_symlink() for path in files):
        fail("distribution staging содержит символическую ссылку")
    checksum_path.write_text(
        "".join(
            f"{sha256_file(path)}  {path.relative_to(staging_root).as_posix()}\n" for path in files
        ),
        encoding="utf-8",
    )
    checksum_path.chmod(0o644)


def verify_compatibility(source_root: Path, distribution: str) -> None:
    path = source_root / "scripts/release/compatibility.json"
    try:
        document = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        fail(f"не удалось прочитать compatibility.json: {error}")
    if not isinstance(document, dict) or document.get("distribution") != distribution:
        fail("compatibility.json принадлежит другому distribution")


def build_distribution(repository_root: Path, version: str, output_dir: Path) -> Path:
    """Проверяет release-ветку, собирает образы и упаковывает проверенный дистрибутив."""

    if not VERSION_PATTERN.fullmatch(version):
        fail("укажи версию вида 0.5.0 или 0.5.0-beta")
    branch = run(
        ["git", "branch", "--show-current"], cwd=repository_root, capture_output=True
    ).stdout.strip()
    if branch != f"release/{version}":
        fail(
            f"сборка {version} разрешена только из ветки release/{version}, "
            f"сейчас {branch or 'detached'}"
        )
    commit = run(
        ["git", "rev-parse", "HEAD"], cwd=repository_root, capture_output=True
    ).stdout.strip()
    if not COMMIT_PATTERN.fullmatch(commit):
        fail("не удалось определить полный commit SHA")
    run(["git", "cat-file", "-e", f"{commit}^{{commit}}"], cwd=repository_root)

    temp_base = Path(os.environ.get("TMPDIR", "/tmp")).resolve()
    with tempfile.TemporaryDirectory(prefix="task-release.", dir=temp_base) as directory:
        temporary_root = Path(directory)
        source_root = temporary_root / "source"
        staging_root = temporary_root / "distribution"
        source_root.mkdir()
        staging_root.mkdir()
        archive_path = temporary_root / "source.tar"

        # Все последующие проверки используют архив принятого commit, поэтому
        # незакоммиченные файлы рабочей директории не попадут в результат.
        print(f"Создаю неизменяемый build context из {commit}...", flush=True)
        run(
            ["git", "archive", "--format=tar", commit, "-o", str(archive_path)],
            cwd=repository_root,
        )
        run(["tar", "-xf", str(archive_path), "-C", str(source_root)])
        normalize_source_tree(source_root)

        config = load_config(source_root.joinpath(*CONFIG_PATH.parts))
        verify_compatibility(source_root, config.distribution)
        output_dir.mkdir(parents=True, exist_ok=True)
        output_zip = output_dir / f"{config.distribution}.zip"
        if output_zip.exists():
            fail(f"архив уже существует: {output_zip}")

        short_commit = commit[:12]
        test_image = f"{config.test_image_repository}:{version}-{short_commit}"
        image = f"{config.image_repository}:{version}-{short_commit}"
        common_build_arguments = [
            "--platform",
            PLATFORM,
            "--load",
            "--provenance=false",
            "--build-arg",
            f"SERVICE_VERSION={version}",
            "--build-arg",
            f"SERVICE_REVISION={commit}",
        ]

        # Сначала проверяется тестовый target из того же контекста, после его успеха
        # строится production-образ с release labels.
        print("Проверяю locked test image из принятого commit...", flush=True)
        run(
            [
                "docker",
                "buildx",
                "build",
                *common_build_arguments,
                "--target",
                "test",
                "--tag",
                test_image,
                str(source_root),
            ]
        )
        run(["docker", "run", "--rm", "--platform", PLATFORM, test_image])

        print(f"Собираю {image} для {PLATFORM}...", flush=True)
        run(
            [
                "docker",
                "buildx",
                "build",
                *common_build_arguments,
                "--target",
                "production",
                "--label",
                f"org.opencontainers.image.revision={commit}",
                "--label",
                f"org.opencontainers.image.version={version}",
                "--label",
                f"org.opencontainers.image.source={config.distribution}",
                "--tag",
                image,
                str(source_root),
            ]
        )
        actual_platform = run(
            ["docker", "image", "inspect", "--format", "{{.Os}}/{{.Architecture}}", image],
            capture_output=True,
        ).stdout.strip()
        if actual_platform != PLATFORM:
            fail(f"собранный образ имеет неверную платформу: {actual_platform}")

        image_check = (
            "import importlib, pathlib; "
            f"importlib.import_module({config.python_package!r}); "
            f"missing=[path for path in {list(config.required_image_files)!r} "
            "if not pathlib.Path(path).is_file()]; "
            "assert not missing, missing"
        )
        run(
            [
                "docker",
                "run",
                "--rm",
                "--platform",
                PLATFORM,
                "--entrypoint",
                "python",
                image,
                "-c",
                image_check,
            ]
        )
        for command in config.image_commands:
            run(
                [
                    "docker",
                    "run",
                    "--rm",
                    "--platform",
                    PLATFORM,
                    "--entrypoint",
                    command.entrypoint,
                    image,
                    *command.arguments,
                ]
            )

        print("Сохраняю Docker-образ...", flush=True)
        save_image(image, staging_root / "image.tar.gz")
        for payload_entry in config.payload:
            copy_payload(source_root, staging_root, payload_entry)

        migration_tool = staging_root / "migration_manifest.py"
        migration_directory = staging_root / "migrations/versions"
        migration_manifest = staging_root / "migrations.tsv"
        run(
            [
                sys.executable,
                str(migration_tool),
                "--directory",
                str(migration_directory),
                "--manifest",
                str(migration_manifest),
                "--write",
            ]
        )

        release_environment = staging_root / "release.env"
        release_environment.write_text(
            "\n".join(
                (
                    f"W_DISTRIBUTION_NAME={config.distribution}",
                    f"W_DISTRIBUTION_VERSION={version}",
                    f"W_DISTRIBUTION_COMMIT={commit}",
                    f"W_DISTRIBUTION_ARCH={PLATFORM}",
                    f"W_DISTRIBUTION_IMAGE={image}",
                    "",
                )
            ),
            encoding="utf-8",
        )
        release_environment.chmod(0o644)

        run(
            [
                sys.executable,
                str(staging_root / "verify_image_archive.py"),
                "--archive",
                str(staging_root / "image.tar.gz"),
                "--image",
                image,
                "--version",
                version,
                "--commit",
                commit,
            ]
        )
        run(
            [
                sys.executable,
                str(migration_tool),
                "--directory",
                str(migration_directory),
                "--manifest",
                str(migration_manifest),
            ],
            stdout=subprocess.DEVNULL,
        )
        write_checksums(staging_root)

        # ZIP создаётся последним: внутри уже лежат проверенные образ, миграции,
        # release metadata и контрольные суммы всего payload.
        run(
            [
                sys.executable,
                str(source_root / "scripts/release/create_distribution_zip.py"),
                "--source",
                str(staging_root),
                "--output",
                str(output_zip),
            ]
        )
        print(f"Готово: {output_zip}")
        print(f"SHA-256: {sha256_file(output_zip)}")
        return output_zip


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("version")
    parser.add_argument("output_dir", nargs="?", type=Path)
    args = parser.parse_args()
    repository_root = Path(__file__).resolve().parents[2]
    output_dir = args.output_dir or repository_root / "artifacts/releases" / args.version
    os.umask(0o077)
    try:
        build_distribution(repository_root, args.version, output_dir.resolve())
    except (OSError, ReleaseBuildError) as error:
        parser.exit(1, f"ОШИБКА: {error}\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

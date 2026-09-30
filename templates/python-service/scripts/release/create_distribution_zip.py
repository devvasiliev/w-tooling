#!/usr/bin/env python3
"""Создаёт детерминированный ZIP-дистрибутив W из подготовленного каталога."""

from __future__ import annotations

import argparse
import os
import stat
import tempfile
import zipfile
from enum import StrEnum
from pathlib import Path

FIXED_TIMESTAMP = (1980, 1, 1, 0, 0, 0)


class DistributionZipErrorCode(StrEnum):
    """Классифицирует отказы упаковки независимо от текста диагностики."""

    SOURCE_NOT_DIRECTORY = "source_not_directory"
    EMPTY_STAGING_DIRECTORY = "empty_staging_directory"
    SYMLINK_FOUND = "symlink_found"


class DistributionZipError(ValueError):
    """Сохраняет код причины и русскую диагностику ошибки упаковки."""

    def __init__(self, code: DistributionZipErrorCode, message: str) -> None:
        super().__init__(message)
        self.code = code


def create_zip(source: Path, output: Path) -> None:
    """Упаковывает обычные файлы с фиксированными метаданными и атомарно заменяет ZIP."""

    if source.is_symlink() or not source.is_dir():
        raise DistributionZipError(
            DistributionZipErrorCode.SOURCE_NOT_DIRECTORY,
            f"источник должен быть обычным каталогом: {source}",
        )
    files = sorted(path for path in source.rglob("*") if path.is_file())
    if not files:
        raise DistributionZipError(
            DistributionZipErrorCode.EMPTY_STAGING_DIRECTORY,
            "каталог подготовки дистрибутива пуст",
        )
    if any(path.is_symlink() for path in files):
        raise DistributionZipError(
            DistributionZipErrorCode.SYMLINK_FOUND,
            "каталог подготовки дистрибутива содержит символическую ссылку",
        )

    output.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary_name = tempfile.mkstemp(
        prefix=f".{output.name}.", suffix=".tmp", dir=output.parent
    )
    os.close(descriptor)
    temporary = Path(temporary_name)
    try:
        with zipfile.ZipFile(temporary, "w", allowZip64=True) as archive:
            for path in files:
                relative = path.relative_to(source).as_posix()
                info = zipfile.ZipInfo(relative, FIXED_TIMESTAMP)
                info.create_system = 3
                mode = stat.S_IMODE(path.stat().st_mode)
                info.external_attr = (stat.S_IFREG | mode) << 16
                compression = (
                    zipfile.ZIP_STORED if relative == "image.tar.gz" else zipfile.ZIP_DEFLATED
                )
                archive.writestr(
                    info,
                    path.read_bytes(),
                    compress_type=compression,
                    compresslevel=9 if compression == zipfile.ZIP_DEFLATED else None,
                )
        os.replace(temporary, output)
    finally:
        temporary.unlink(missing_ok=True)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    create_zip(args.source.resolve(), args.output.resolve())
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

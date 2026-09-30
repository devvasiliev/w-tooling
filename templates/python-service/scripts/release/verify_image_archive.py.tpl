#!/usr/bin/env python3
"""Проверяет архив docker save без загрузки в Docker."""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
import tarfile
from enum import StrEnum
from pathlib import Path, PurePosixPath

SHA_PATTERN = re.compile(r"^[0-9a-f]{40}$")
IMAGE_ID_PATTERN = re.compile(r"^sha256:[0-9a-f]{64}$")
IMAGE_CONFIG_PATTERN = re.compile(
    r"^(?:(?P<legacy_digest>[0-9a-f]{64})\.json|"
    r"blobs/sha256/(?P<blob_digest>[0-9a-f]{64}))$"
)


class ImageArchiveErrorCode(StrEnum):
    """Классифицирует отказы проверки архива независимо от текста диагностики."""

    INVALID_EXPECTED_CONFIG_ID = "invalid_expected_config_id"
    INVALID_INSPECTION_RESULT = "invalid_inspection_result"
    INSPECTED_IMAGE_MISMATCH = "inspected_image_mismatch"
    UNSAFE_TAR_MEMBER = "unsafe_tar_member"
    INVALID_JSON_MEMBER = "invalid_json_member"
    UNREADABLE_JSON_MEMBER = "unreadable_json_member"
    INVALID_JSON = "invalid_json"
    INVALID_COMMIT = "invalid_commit"
    EMPTY_ARCHIVE = "empty_archive"
    FORBIDDEN_ARCHIVE_MEMBER = "forbidden_archive_member"
    INVALID_MANIFEST = "invalid_manifest"
    INVALID_MANIFEST_ENTRY = "invalid_manifest_entry"
    MANIFEST_IMAGE_MISMATCH = "manifest_image_mismatch"
    CONFIG_DIGEST_MISMATCH = "config_digest_mismatch"
    INVALID_CONFIG = "invalid_config"
    PLATFORM_MISMATCH = "platform_mismatch"
    MISSING_RUNTIME_CONFIG = "missing_runtime_config"
    LABEL_MISMATCH = "label_mismatch"
    ARCHIVE_READ_FAILED = "archive_read_failed"


class ImageArchiveError(RuntimeError):
    """Сохраняет код причины и русскую диагностику отказа проверки."""

    def __init__(self, code: ImageArchiveErrorCode, message: str) -> None:
        super().__init__(message)
        self.code = code


def accepted_loaded_image_id(
    document: object,
    *,
    image: str,
    expected_config_id: str,
) -> str:
    """Связывает идентичность образа Docker при запуске с конфигурацией архива."""

    if not IMAGE_ID_PATTERN.fullmatch(expected_config_id):
        raise ImageArchiveError(
            ImageArchiveErrorCode.INVALID_EXPECTED_CONFIG_ID,
            "ожидаемый ID конфигурации недействителен",
        )
    if not isinstance(document, list) or len(document) != 1:
        raise ImageArchiveError(
            ImageArchiveErrorCode.INVALID_INSPECTION_RESULT,
            "результат проверки загруженного образа должен содержать один образ",
        )
    inspected = document[0]
    if not isinstance(inspected, dict):
        raise ImageArchiveError(
            ImageArchiveErrorCode.INVALID_INSPECTION_RESULT,
            "результат проверки загруженного образа недействителен",
        )

    image_id = inspected.get("Id")
    repo_tags = inspected.get("RepoTags")
    descriptor = inspected.get("Descriptor")
    annotations = descriptor.get("annotations") if isinstance(descriptor, dict) else None
    descriptor_matches = (
        isinstance(descriptor, dict)
        and descriptor.get("digest") == image_id
        and isinstance(annotations, dict)
        and annotations.get("config.digest") == expected_config_id
    )
    if (
        not isinstance(image_id, str)
        or not IMAGE_ID_PATTERN.fullmatch(image_id)
        or not isinstance(repo_tags, list)
        or image not in repo_tags
        or inspected.get("Os") != "linux"
        or inspected.get("Architecture") != "amd64"
        or (image_id != expected_config_id and not descriptor_matches)
    ):
        raise ImageArchiveError(
            ImageArchiveErrorCode.INSPECTED_IMAGE_MISMATCH,
            "загруженный образ не соответствует проверенной конфигурации архива",
        )
    return image_id


def _safe_member_name(name: str) -> None:
    path = PurePosixPath(name)
    if not name or name.startswith("/") or any(part in ("", ".", "..") for part in path.parts):
        raise ImageArchiveError(
            ImageArchiveErrorCode.UNSAFE_TAR_MEMBER,
            f"небезопасный элемент tar: {name!r}",
        )


def _load_json_member(archive: tarfile.TarFile, name: str) -> tuple[object, bytes]:
    member = archive.getmember(name)
    if not member.isfile() or member.size > 16 * 1024 * 1024:
        raise ImageArchiveError(
            ImageArchiveErrorCode.INVALID_JSON_MEMBER,
            f"недействительный элемент JSON: {name}",
        )
    source = archive.extractfile(member)
    if source is None:
        raise ImageArchiveError(
            ImageArchiveErrorCode.UNREADABLE_JSON_MEMBER,
            f"не удалось прочитать элемент JSON: {name}",
        )
    try:
        payload = source.read()
        return json.loads(payload), payload
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise ImageArchiveError(
            ImageArchiveErrorCode.INVALID_JSON,
            f"недействительный JSON в {name}: {error}",
        ) from error


def verify_archive(archive_path: Path, *, image: str, version: str, commit: str) -> str:
    """Проверяет безопасную структуру архива, digest config и release labels образа."""

    if SHA_PATTERN.fullmatch(commit) is None:
        raise ImageArchiveError(
            ImageArchiveErrorCode.INVALID_COMMIT,
            "ожидаемый commit должен быть полным SHA в нижнем регистре",
        )
    try:
        with tarfile.open(archive_path, mode="r:gz") as archive:
            members = archive.getmembers()
            if not members:
                raise ImageArchiveError(
                    ImageArchiveErrorCode.EMPTY_ARCHIVE,
                    "архив образа пуст",
                )
            for member in members:
                _safe_member_name(member.name)
                if member.issym() or member.islnk() or member.isdev():
                    raise ImageArchiveError(
                        ImageArchiveErrorCode.FORBIDDEN_ARCHIVE_MEMBER,
                        f"ссылки и устройства запрещены: {member.name}",
                    )

            manifest, _ = _load_json_member(archive, "manifest.json")
            if not isinstance(manifest, list) or len(manifest) != 1:
                raise ImageArchiveError(
                    ImageArchiveErrorCode.INVALID_MANIFEST,
                    "манифест Docker должен описывать ровно один образ",
                )
            entry = manifest[0]
            if not isinstance(entry, dict):
                raise ImageArchiveError(
                    ImageArchiveErrorCode.INVALID_MANIFEST_ENTRY,
                    "запись манифеста Docker недействительна",
                )
            tags = entry.get("RepoTags")
            config_name = entry.get("Config")
            config_match = (
                IMAGE_CONFIG_PATTERN.fullmatch(config_name)
                if isinstance(config_name, str)
                else None
            )
            if tags != [image] or config_match is None:
                raise ImageArchiveError(
                    ImageArchiveErrorCode.MANIFEST_IMAGE_MISMATCH,
                    "образ в манифесте Docker не соответствует release.env",
                )

            config_digest = config_match.group("legacy_digest") or config_match.group("blob_digest")
            config, config_payload = _load_json_member(archive, config_name)
            if hashlib.sha256(config_payload).hexdigest() != config_digest:
                raise ImageArchiveError(
                    ImageArchiveErrorCode.CONFIG_DIGEST_MISMATCH,
                    "digest конфигурации образа Docker не совпадает",
                )
            if not isinstance(config, dict):
                raise ImageArchiveError(
                    ImageArchiveErrorCode.INVALID_CONFIG,
                    "конфигурация образа Docker недействительна",
                )
            if config.get("os") != "linux" or config.get("architecture") != "amd64":
                raise ImageArchiveError(
                    ImageArchiveErrorCode.PLATFORM_MISMATCH,
                    "образ Docker не предназначен для linux/amd64",
                )
            container_config = config.get("config")
            if not isinstance(container_config, dict):
                raise ImageArchiveError(
                    ImageArchiveErrorCode.MISSING_RUNTIME_CONFIG,
                    "образ Docker не содержит конфигурацию запуска",
                )
            labels = container_config.get("Labels") or {}
            expected = {
                "org.opencontainers.image.revision": commit,
                "org.opencontainers.image.version": version,
                "org.opencontainers.image.source": "__SERVICE_NAME__",
            }
            if not isinstance(labels, dict) or any(
                labels.get(key) != value for key, value in expected.items()
            ):
                raise ImageArchiveError(
                    ImageArchiveErrorCode.LABEL_MISMATCH,
                    "метки выпуска образа Docker не совпадают",
                )
            return f"sha256:{config_digest}"
    except (OSError, tarfile.TarError, KeyError) as error:
        raise ImageArchiveError(
            ImageArchiveErrorCode.ARCHIVE_READ_FAILED,
            str(error),
        ) from error


def main() -> int:
    parser = argparse.ArgumentParser()
    source = parser.add_mutually_exclusive_group(required=True)
    source.add_argument("--archive", type=Path)
    source.add_argument("--inspect-json", action="store_true")
    parser.add_argument("--image", required=True)
    parser.add_argument("--version")
    parser.add_argument("--commit")
    parser.add_argument("--expected-config-id")
    parser.add_argument("--print-image-id", action="store_true")
    args = parser.parse_args()
    try:
        if args.archive is not None:
            if args.version is None or args.commit is None:
                parser.error("с --archive требуются --version и --commit")
            image_id = verify_archive(
                args.archive,
                image=args.image,
                version=args.version,
                commit=args.commit,
            )
        else:
            if args.expected_config_id is None:
                parser.error("с --inspect-json требуется --expected-config-id")
            image_id = accepted_loaded_image_id(
                json.load(sys.stdin),
                image=args.image,
                expected_config_id=args.expected_config_id,
            )
    except ImageArchiveError as error:
        parser.exit(
            1,
            f"недействительная идентичность образа [{error.code}]: {error}\n",
        )
    except json.JSONDecodeError as error:
        parser.exit(
            1,
            "недействительная идентичность образа "
            f"[{ImageArchiveErrorCode.INVALID_JSON}]: {error}\n",
        )
    if args.print_image_id:
        print(image_id)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

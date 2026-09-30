from __future__ import annotations

import hashlib
import importlib.util
import io
import json
import sys
import tarfile
import tempfile
import unittest
from pathlib import Path
from types import ModuleType

ROOT = Path(__file__).parents[1]
BUILDER_PATH = (
    ROOT / "templates/python-service/scripts/release/build_distribution.py"
)
VERIFIER_TEMPLATE_PATH = (
    ROOT / "templates/python-service/scripts/release/verify_image_archive.py.tpl"
)


def load_builder() -> ModuleType:
    spec = importlib.util.spec_from_file_location("project_release_builder", BUILDER_PATH)
    if spec is None or spec.loader is None:
        raise RuntimeError("release builder cannot be imported")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def load_verifier(directory: Path) -> ModuleType:
    path = directory / "verify_image_archive.py"
    path.write_text(
        VERIFIER_TEMPLATE_PATH.read_text(encoding="utf-8").replace(
            "__SERVICE_NAME__", "task-example"
        ),
        encoding="utf-8",
    )
    spec = importlib.util.spec_from_file_location("project_image_verifier", path)
    if spec is None or spec.loader is None:
        raise RuntimeError("image verifier cannot be imported")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def add_json_member(archive: tarfile.TarFile, name: str, value: object) -> None:
    payload = json.dumps(value).encode()
    member = tarfile.TarInfo(name)
    member.size = len(payload)
    archive.addfile(member, io.BytesIO(payload))


BUILDER = load_builder()


def manifest(*, payload: list[dict[str, object]] | None = None) -> dict[str, object]:
    return {
        "schema_version": 1,
        "distribution": "task-example",
        "python_package": "project_example",
        "image_repository": "project/example",
        "test_image_repository": "project/example-test",
        "required_image_files": ["/app/openapi.yaml"],
        "image_commands": [],
        "payload": payload
        or [
            {"source": "compatibility.json", "target": "compatibility.json"},
            {"source": "deploy.sh", "target": "deploy.sh", "executable": True},
            {"source": "migration_manifest.py", "target": "migration_manifest.py"},
            {"source": "versions", "target": "migrations/versions"},
            {"source": "openapi.yaml", "target": "openapi.yaml"},
            {"source": "verify.py", "target": "verify_image_archive.py"},
        ],
    }


class ReleaseBuilderTest(unittest.TestCase):
    def test_source_normalization_preserves_git_executable_intent(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            executable = root / "build-distribution.sh"
            regular = root / "distribution.json"
            executable.write_text("#!/bin/sh\n", encoding="utf-8")
            regular.write_text("{}\n", encoding="utf-8")
            executable.chmod(0o775)
            regular.chmod(0o664)

            BUILDER.normalize_source_tree(root)

            self.assertEqual(executable.stat().st_mode & 0o777, 0o755)
            self.assertEqual(regular.stat().st_mode & 0o777, 0o644)

    def test_manifest_is_strict_and_keeps_service_owned_payload(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "distribution.json"
            path.write_text(json.dumps(manifest()), encoding="utf-8")

            config = BUILDER.load_config(path)

            self.assertEqual(config.distribution, "task-example")
            self.assertEqual(config.python_package, "project_example")
            self.assertEqual(
                [entry.target.as_posix() for entry in config.payload],
                [
                    "compatibility.json",
                    "deploy.sh",
                    "migration_manifest.py",
                    "migrations/versions",
                    "openapi.yaml",
                    "verify_image_archive.py",
                ],
            )

    def test_manifest_rejects_path_traversal_and_overlapping_targets(self) -> None:
        cases = [
            [
                {"source": "../secret", "target": "compatibility.json"},
                {"source": "deploy.sh", "target": "deploy.sh"},
                {"source": "migration.py", "target": "migration_manifest.py"},
                {"source": "versions", "target": "migrations/versions"},
                {"source": "openapi", "target": "openapi.yaml"},
                {"source": "verify", "target": "verify_image_archive.py"},
            ],
            [
                {"source": "compatibility", "target": "compatibility.json"},
                {"source": "deploy.sh", "target": "deploy.sh"},
                {"source": "migration.py", "target": "migration_manifest.py"},
                {"source": "versions", "target": "migrations/versions"},
                {"source": "extra", "target": "migrations"},
                {"source": "openapi", "target": "openapi.yaml"},
                {"source": "verify", "target": "verify_image_archive.py"},
            ],
        ]
        for payload in cases:
            with self.subTest(payload=payload), tempfile.TemporaryDirectory() as directory:
                path = Path(directory) / "distribution.json"
                path.write_text(json.dumps(manifest(payload=payload)), encoding="utf-8")
                with self.assertRaises(BUILDER.ReleaseBuildError):
                    BUILDER.load_config(path)

    def test_payload_copy_and_checksums_are_deterministic(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "source"
            staging = root / "staging"
            source.mkdir()
            staging.mkdir()
            (source / "payload.txt").write_text("payload\n", encoding="utf-8")
            entry = BUILDER.PayloadEntry(
                source=BUILDER.PurePosixPath("payload.txt"),
                target=BUILDER.PurePosixPath("nested/payload.txt"),
                executable=False,
            )

            BUILDER.copy_payload(source, staging, entry)
            BUILDER.write_checksums(staging)

            expected = BUILDER.sha256_file(staging / "nested/payload.txt")
            self.assertEqual(
                (staging / "SHA256SUMS").read_text(encoding="utf-8"),
                f"{expected}  nested/payload.txt\n",
            )

    def test_image_verifier_accepts_modern_archive_without_repositories_file(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            verifier = load_verifier(root)
            archive_path = root / "image.tar.gz"
            image = "project/example:1.2.3-0123456789ab"
            commit = "0123456789abcdef0123456789abcdef01234567"
            config = {
                "architecture": "amd64",
                "os": "linux",
                "config": {
                    "Labels": {
                        "org.opencontainers.image.revision": commit,
                        "org.opencontainers.image.version": "1.2.3",
                        "org.opencontainers.image.source": "task-example",
                    }
                },
            }
            config_digest = hashlib.sha256(json.dumps(config).encode()).hexdigest()
            config_name = f"blobs/sha256/{config_digest}"
            with tarfile.open(archive_path, mode="w:gz") as archive:
                add_json_member(
                    archive,
                    "manifest.json",
                    [{"Config": config_name, "RepoTags": [image], "Layers": []}],
                )
                add_json_member(archive, config_name, config)
                add_json_member(archive, "oci-layout", {"imageLayoutVersion": "1.0.0"})

            verifier.verify_archive(
                archive_path,
                image=image,
                version="1.2.3",
                commit=commit,
            )


if __name__ == "__main__":
    unittest.main(verbosity=2)

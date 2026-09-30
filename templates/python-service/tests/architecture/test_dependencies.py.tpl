from __future__ import annotations

import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

from scripts.check_architecture import check_repository


class ArchitectureTest(unittest.TestCase):
    def test_template_has_no_architecture_violations(self) -> None:
        self.assertEqual(check_repository(Path.cwd(), "__SERVICE_PACKAGE__"), [])

    def test_checker_allows_inner_and_standard_library_imports(self) -> None:
        with TemporaryDirectory() as temporary:
            root = Path(temporary)
            application = root / "src" / "sample" / "application"
            application.mkdir(parents=True)
            (application / "clean.py").write_text(
                "from dataclasses import dataclass\nfrom sample.domain import model\n",
                encoding="utf-8",
            )

            self.assertEqual(check_repository(root, "sample"), [])

    def test_checker_rejects_outer_framework_sibling_and_dynamic_bypasses(self) -> None:
        with TemporaryDirectory() as temporary:
            root = Path(temporary)
            package = root / "src" / "sample"
            domain = package / "domain"
            application = package / "application"
            adapters = package / "adapters"
            bootstrap = package / "bootstrap"
            for directory in (domain, application, adapters, bootstrap):
                directory.mkdir(parents=True)

            (domain / "bad.py").write_text("import fastapi\n", encoding="utf-8")
            (application / "bad.py").write_text(
                "from .. import adapters\nimport importlib\n"
                "importlib.import_module('sample.bootstrap')\n",
                encoding="utf-8",
            )
            (adapters / "bad.py").write_text(
                "from sample.bootstrap import settings\n",
                encoding="utf-8",
            )
            (bootstrap / "bad.py").write_text(
                "import project_other\nSIBLING = '../task-other'\n",
                encoding="utf-8",
            )

            violations = check_repository(root, "sample")

        self.assertEqual(
            {item.dependency for item in violations},
            {
                "../task-other",
                "fastapi",
                "importlib.import_module",
                "sample.adapters",
                "sample.bootstrap",
                "project_other",
            },
        )


if __name__ == "__main__":
    unittest.main()

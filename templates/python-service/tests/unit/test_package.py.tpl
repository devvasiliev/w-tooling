from __future__ import annotations

import unittest

from __SERVICE_PACKAGE__ import __version__


class PackageTest(unittest.TestCase):
    def test_version_is_exposed(self) -> None:
        self.assertEqual(__version__, "0.1.0")


if __name__ == "__main__":
    unittest.main()

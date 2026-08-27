# -*- coding: utf-8 -*-
from __future__ import annotations

import sys
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from push_data import LINGXING_SECRET_PATTERN


class PushSecretGuardTests(unittest.TestCase):
    def test_blank_template_does_not_consume_next_environment_line(self):
        sample = "LINGXING_APP_" + "SECRET=\nLINGXING_SIDS=101,102\n"
        self.assertIsNone(LINGXING_SECRET_PATTERN.search(sample))

    def test_non_empty_app_secret_is_detected(self):
        for sample in (
            "LINGXING_APP_" + "SECRET=actual-secret",
            "LINGXING_APP_" + "SECRET = actual-secret",
        ):
            with self.subTest(sample=sample):
                self.assertIsNotNone(LINGXING_SECRET_PATTERN.search(sample))


if __name__ == "__main__":
    unittest.main()

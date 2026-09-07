# -*- coding: utf-8 -*-
from __future__ import annotations

import os
import sys
import unittest
from pathlib import Path
from unittest import mock


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from lingxing_bridge import (
    BridgeProblem,
    BridgeRuntime,
    SyncOptions,
    build_sync_command,
    configured_origins,
    credentials_configured,
    is_allowed_origin,
    is_loopback_host,
    normalize_sync_request,
    sanitize_output,
    validate_bind_host,
)


class BridgeSecurityTests(unittest.TestCase):
    def test_only_loopback_host_headers_are_accepted(self):
        self.assertTrue(is_loopback_host("127.0.0.1:8765"))
        self.assertTrue(is_loopback_host("localhost:8765"))
        self.assertTrue(is_loopback_host("[::1]:8765"))
        self.assertFalse(is_loopback_host("example.com"))
        self.assertFalse(is_loopback_host("127.0.0.1.example.com"))

    def test_origin_allowlist_accepts_dashboard_and_local_development(self):
        allowed = configured_origins()
        self.assertTrue(
            is_allowed_origin("https://kevinzuo-amz.github.io", allowed)
        )
        self.assertTrue(is_allowed_origin("http://127.0.0.1:4173", allowed))
        self.assertTrue(is_allowed_origin("http://localhost:8080", allowed))
        self.assertTrue(is_allowed_origin("null", allowed))
        self.assertFalse(is_allowed_origin("https://example.com", allowed))
        self.assertFalse(
            is_allowed_origin("https://kevinzuo-amz.github.io.evil.test", allowed)
        )

    def test_bridge_rejects_non_loopback_bind_address(self):
        validate_bind_host("127.0.0.1")
        validate_bind_host("::1")
        with self.assertRaisesRegex(ValueError, "只能监听"):
            validate_bind_host("0.0.0.0")

    def test_pairing_key_has_minimum_length(self):
        BridgeRuntime("a" * 16)
        with self.assertRaisesRegex(ValueError, "至少需要"):
            BridgeRuntime("short")

    def test_sensitive_output_is_redacted(self):
        github_token = "ghp_" + "abcdefghijklmnopqrstuvwxyz123456"
        with mock.patch.dict(
            os.environ,
            {
                "LINGXING_APP_ID": "1234567890abcdef",
                "LINGXING_APP_SECRET": "top-secret-value",
                "GITHUB_TOKEN": github_token,
            },
            clear=False,
        ):
            output = sanitize_output(
                "app=1234567890abcdef secret=top-secret-value "
                "token=" + github_token
            )
        self.assertNotIn("top-secret-value", output)
        self.assertNotIn("1234567890abcdef", output)
        self.assertNotIn("ghp_", output)

    def test_credentials_status_requires_both_values(self):
        with mock.patch.dict(
            os.environ,
            {"LINGXING_APP_ID": "app", "LINGXING_APP_SECRET": ""},
            clear=False,
        ):
            self.assertFalse(credentials_configured())
        with mock.patch.dict(
            os.environ,
            {"LINGXING_APP_ID": "app", "LINGXING_APP_SECRET": "secret"},
            clear=False,
        ):
            self.assertTrue(credentials_configured())


class BridgeRequestTests(unittest.TestCase):
    def test_normalize_sync_request(self):
        options = normalize_sync_request(
            {
                "days": "30",
                "datasets": ["stock", "performance", "stock"],
                "includeToday": True,
                "publish": False,
            }
        )
        self.assertEqual(
            options,
            SyncOptions(
                days=30,
                datasets=("stock", "performance"),
                include_today=True,
                publish=False,
            ),
        )

    def test_normalize_sync_request_uses_safe_defaults(self):
        options = normalize_sync_request({})
        self.assertEqual(options.days, 7)
        self.assertEqual(options.datasets, ("performance", "stock"))
        self.assertFalse(options.include_today)
        self.assertFalse(options.publish)

    def test_invalid_sync_inputs_are_rejected(self):
        for payload in (
            {"days": 0},
            {"days": 93},
            {"days": True},
            {"datasets": []},
            {"datasets": ["unknown"]},
            {"datasets": "performance"},
            {"publish": "yes"},
        ):
            with self.subTest(payload=payload):
                with self.assertRaises(BridgeProblem):
                    normalize_sync_request(payload)

    def test_sync_command_is_fixed_argument_list(self):
        options = SyncOptions(
            days=14,
            datasets=("performance", "stock"),
            include_today=True,
        )
        command = build_sync_command(options, "/safe/python")
        self.assertEqual(command[0], "/safe/python")
        self.assertIn("--days", command)
        self.assertIn("14", command)
        self.assertIn("performance,stock", command)
        self.assertIn("--include-today", command)
        self.assertNotIn("shell=True", command)


if __name__ == "__main__":
    unittest.main()

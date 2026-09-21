# -*- coding: utf-8 -*-
from __future__ import annotations

import importlib.util
import sys
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from lingxing_api import LingxingApiError, LingxingClient, canonicalize_params, generate_sign
from sync_lingxing_api import (
    attach_out_stock_dates,
    build_listing_index,
    build_stock,
    map_performance_day,
    merge_dashboard_data,
    select_sids,
    validate_dashboard_data,
)


HAS_CRYPTO = importlib.util.find_spec("Crypto") is not None
APP_ID = "1234567890abcdef"


class FakeTransport:
    def __init__(self, responses):
        self.responses = list(responses)
        self.calls = []

    def request(self, method, url, **kwargs):
        self.calls.append((method, url, kwargs))
        if not self.responses:
            raise AssertionError("unexpected transport call")
        response = self.responses.pop(0)
        if isinstance(response, Exception):
            raise response
        return response


class SignatureTests(unittest.TestCase):
    def test_canonicalize_matches_official_sdk_rules(self):
        params = {
            "timestamp": "1720408272",
            "offset": 0,
            "filters": [{"b": 2, "a": 1}],
            "empty": "",
            "nil": None,
            "app_key": APP_ID,
            "access_token": "token-123",
        }
        self.assertEqual(
            canonicalize_params(params),
            'access_token=token-123&app_key=1234567890abcdef&filters=[{"a":1,"b":2}]'
            "&nil=None&offset=0&timestamp=1720408272",
        )

    @unittest.skipUnless(HAS_CRYPTO, "pycryptodome not installed")
    def test_signature_matches_independent_aes_vector(self):
        params = {
            "timestamp": "1720408272",
            "offset": 0,
            "filters": [{"b": 2, "a": 1}],
            "empty": "",
            "nil": None,
            "app_key": APP_ID,
            "access_token": "token-123",
        }
        self.assertEqual(
            generate_sign(APP_ID, params),
            "J8zfsa1eATHSmiY5jifoKMIU6dbVY/fSoPpViUMd3J8C3sVlLAIV+Tr2nwCfD21Y",
        )


@unittest.skipUnless(HAS_CRYPTO, "pycryptodome not installed")
class ClientTests(unittest.TestCase):
    def token_response(self):
        return {
            "code": "200",
            "msg": "OK",
            "data": {
                "access_token": "token-123",
                "refresh_token": "refresh-123",
                "expires_in": 7199,
            },
        }

    def test_business_request_is_signed_and_token_stays_in_memory(self):
        transport = FakeTransport(
            [
                self.token_response(),
                {"code": 0, "message": "success", "data": [{"sid": 10}]},
            ]
        )
        client = LingxingClient(
            APP_ID,
            "secret",
            transport=transport,
            clock=lambda: 1720408272,
            sleeper=lambda _: None,
        )
        self.assertEqual(client.sellers(), [{"sid": 10}])
        token_call, seller_call = transport.calls
        self.assertEqual(token_call[2]["form"]["appId"], APP_ID)
        query = seller_call[2]["query"]
        self.assertEqual(query["access_token"], "token-123")
        self.assertEqual(query["app_key"], APP_ID)
        self.assertEqual(query["timestamp"], "1720408272")
        self.assertTrue(query["sign"])

    def test_pagination_uses_total_even_when_page_is_short(self):
        transport = FakeTransport(
            [
                self.token_response(),
                {
                    "code": 0,
                    "data": [{"asin": "A"}, {"asin": "B"}],
                    "total": 3,
                },
                {"code": 0, "data": [{"asin": "C"}], "total": 3},
            ]
        )
        client = LingxingClient(
            APP_ID,
            "secret",
            transport=transport,
            clock=lambda: 1720408272,
            sleeper=lambda _: None,
        )
        rows = client.listings([1])
        self.assertEqual([row["asin"] for row in rows], ["A", "B", "C"])
        self.assertEqual(transport.calls[1][2]["body"]["offset"], 0)
        self.assertEqual(transport.calls[2][2]["body"]["offset"], 2)

    def test_rate_limit_is_retried_with_a_fresh_signature(self):
        transport = FakeTransport(
            [
                self.token_response(),
                {"code": 3001008, "message": "requests too frequently"},
                {"code": 0, "data": []},
            ]
        )
        sleeps = []
        client = LingxingClient(
            APP_ID,
            "secret",
            transport=transport,
            clock=lambda: 1720408272,
            sleeper=sleeps.append,
        )
        self.assertEqual(client.sellers(), [])
        self.assertEqual(sleeps, [1])


class MappingTests(unittest.TestCase):
    def setUp(self):
        self.listings = [
            {
                "sid": 1,
                "asin": "b012345678",
                "parent_asin": "b087654321",
                "local_name": "测试产品",
                "local_sku": "SKU-1",
                "seller_sku": "MSKU-1",
                "status": 1,
            }
        ]
        self.index = build_listing_index(self.listings)

    def performance_row(self):
        return {
            "asins": [{"asin": "B012345678", "sid": 1}],
            "parent_asins": [{"parent_asin": "B087654321", "sid": 1}],
            "amount": "100.50",
            "order_items": 4,
            "volume": 5,
            "sessions_total": 10,
            "predict_gross_profit": 20.25,
            "return_amount": 2,
            "impressions": 1000,
            "clicks": 6,
            "spend": 12,
            "ad_sales_amount": 40,
            "ad_order_quantity": 3,
            "avg_star": 4.7,
            "reviews_count": 20,
            "buy_box_percentage": 0.8,
            "predict_gross_margin": 0.2,
            "gross_margin": 0.19,
            "roi": 1.5,
            "return_rate": 0.02,
            "acos": 0.3,
            "acoas": 0.12,
            "tacos": 0.1,
            "roas": 3.3333,
            "small_cate_rank": [{"rank": 12}, {"rank": 4}],
        }

    def test_performance_mapping_matches_dashboard_contract(self):
        rows = map_performance_day(
            "2026-08-21", [self.performance_row()], self.index, include_cols=True
        )
        self.assertEqual(len(rows), 1)
        row = rows[0]
        self.assertEqual(row["asin"], "B012345678")
        self.assertEqual(row["pasin"], "B087654321")
        self.assertEqual(row["name"], "测试产品")
        self.assertEqual(row["naturalOrders"], 1)
        self.assertEqual(row["natClicks"], 4)
        self.assertEqual(row["cpc"], 2)
        self.assertEqual(row["adUnits"], 3)
        self.assertEqual(row["cols"]["ACOS"], 30)
        self.assertEqual(row["cols"]["Buybox赢得率"], 80)
        self.assertEqual(row["cols"]["小类排名"], 4)

    def test_stock_mapping_joins_replenishment_inventory_and_listing(self):
        replenishment = [
            {
                "basic_info": {"asin": "B012345678"},
                "amazon_quantity_info": {
                    "afn_fulfillable_quantity": 10,
                    "amazon_quantity_shipping": 6,
                    "reserved_fc_transfers": 2,
                    "reserved_fc_processing": 1,
                },
                "sales_info": {
                    "sales_avg_3": 3,
                    "sales_avg_7": 2.5,
                    "sales_avg_14": 2,
                    "sales_avg_30": 1.5,
                    "sales_avg_60": 1,
                    "sales_avg_90": 0.5,
                },
                "suggest_info": {"out_stock_date": "2026-09-01"},
            }
        ]
        inventory = [
            {
                "asin": "B012345678",
                "afn_fulfillable_quantity": 11,
                "inv_age_0_to_90_days": 8,
                "inv_age_91_to_180_days": 2,
                "inv_age_181_to_270_days": 1,
                "inv_age_271_to_365_days": 0,
                "inv_age_365_plus_days": 4,
            }
        ]
        stock, out_dates = build_stock(replenishment, inventory, self.index)
        self.assertEqual(stock[0]["sku"], "SKU-1")
        self.assertEqual(stock[0]["avail"], 10)
        self.assertEqual(stock[0]["daily"]["d7"], 2.5)
        self.assertEqual(stock[0]["aging"]["a12p"], 4)
        self.assertEqual(out_dates["B012345678"], "2026-09-01")

    def test_merge_preserves_manual_and_operational_sections(self):
        performance = map_performance_day(
            "2026-08-21", [self.performance_row()], self.index, include_cols=True
        )
        attach_out_stock_dates(performance, {"B012345678": "2026-09-01"})
        current = {
            "perf": {"detail": []},
            "stock": [],
            "ad": {"detail": []},
            "profit": {"detail": [], "nameMap": {}},
            "mine": [{"id": "mine"}],
            "promo": {"items": [{"asin": "keep"}]},
            "tasks": [{"id": "task"}],
            "track": {"meta": {"owner": "local"}},
        }
        merged = merge_dashboard_data(
            current,
            performance=performance,
            stock=[{"asin": "B012345678"}],
            synced_at="2026-08-22T00:00:00Z",
        )
        for key in ("mine", "promo", "tasks", "track"):
            self.assertEqual(merged[key], current[key])
        self.assertEqual(merged["perf"]["detail"][0]["cols"]["断货时间"], "2026-09-01")
        self.assertEqual(merged["ad"]["detail"][0]["spend"], 12)
        self.assertEqual(merged["profit"]["detail"][0]["gross"], 20.25)
        validate_dashboard_data(
            merged, ("performance", "stock"), allow_empty=False
        )

    def test_empty_core_dataset_is_blocked_by_default(self):
        data = {"perf": {"detail": []}, "stock": [], "mine": [], "promo": {}, "tasks": [], "track": {}}
        with self.assertRaisesRegex(ValueError, "产品表现为空"):
            validate_dashboard_data(
                data, ("performance", "stock"), allow_empty=False
            )

    def test_store_selection_uses_active_stores_and_checks_requested_ids(self):
        sellers = [
            {"sid": 1, "status": 1},
            {"sid": 2, "status": 0},
            {"sid": 3, "status": 1},
        ]
        self.assertEqual(select_sids(sellers, []), [1, 3])
        self.assertEqual(select_sids(sellers, [2]), [2])
        with self.assertRaisesRegex(ValueError, "不在领星授权店铺"):
            select_sids(sellers, [99])


if __name__ == "__main__":
    unittest.main()

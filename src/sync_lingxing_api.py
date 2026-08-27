# -*- coding: utf-8 -*-
"""Fetch Lingxing OpenAPI data and update this dashboard's local data contract."""

from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import sys
import tempfile
from pathlib import Path
from typing import Any, Dict, Iterable, List, Mapping, Optional, Sequence, Tuple

from lingxing_api import LingxingApiError, LingxingClient


BASE = Path(__file__).resolve().parent
REPO_ROOT = BASE.parent
DATA_PATH = REPO_ROOT / "amz-data.json"
CLOUD_STATUS_PATH = REPO_ROOT / "cloud-status.json"
DEFAULT_DATASETS = ("performance", "stock")
DATASET_NAMES = set(DEFAULT_DATASETS)


def load_dotenv(path: Path) -> None:
    """Load a simple local .env file without overriding process variables."""
    if not path.exists():
        return
    for raw_line in path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        value = value.strip()
        if value[:1] == value[-1:] and value[:1] in ("'", '"'):
            value = value[1:-1]
        if key:
            os.environ.setdefault(key, value)


def parse_args(argv: Optional[Sequence[str]] = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="通过领星官方 OpenAPI 刷新 AMZ-ZK 看板数据"
    )
    parser.add_argument("--start-date", help="开始日期 YYYY-MM-DD")
    parser.add_argument("--end-date", help="结束日期 YYYY-MM-DD，默认昨天")
    parser.add_argument(
        "--days",
        type=int,
        default=int(os.environ.get("LINGXING_LOOKBACK_DAYS", "90")),
        help="未指定开始日期时的回看天数，默认 90，最大 92",
    )
    parser.add_argument(
        "--sids",
        default=os.environ.get("LINGXING_SIDS", ""),
        help="逗号分隔店铺 sid；留空时使用全部正常店铺",
    )
    parser.add_argument(
        "--datasets",
        default=",".join(DEFAULT_DATASETS),
        help="performance,stock 的逗号分隔子集",
    )
    parser.add_argument(
        "--currency",
        default=os.environ.get("LINGXING_CURRENCY_CODE", "USD"),
        help="产品表现统一币种，支持 USD、CNY；留空为原币种",
    )
    parser.add_argument(
        "--include-today",
        action="store_true",
        help="默认只同步到昨天；指定后可把今天的不完整数据纳入",
    )
    parser.add_argument(
        "--allow-empty",
        action="store_true",
        help="允许 API 返回空核心数据并写入（默认阻止误清空）",
    )
    parser.add_argument(
        "--dry-run", action="store_true", help="抓取并校验，但不写文件、不生成发布版"
    )
    parser.add_argument(
        "--no-build", action="store_true", help="写数据但不重新生成 dashboard.html/index.html"
    )
    return parser.parse_args(argv)


def resolve_dates(args: argparse.Namespace) -> Tuple[dt.date, dt.date]:
    today = dt.date.today()
    default_end = today if args.include_today else today - dt.timedelta(days=1)
    end = parse_date(args.end_date) if args.end_date else default_end
    if args.start_date:
        start = parse_date(args.start_date)
    else:
        if not 1 <= args.days <= 92:
            raise ValueError("--days 必须在 1 到 92 之间")
        start = end - dt.timedelta(days=args.days - 1)
    if start > end:
        raise ValueError("开始日期不能晚于结束日期")
    if (end - start).days > 91:
        raise ValueError("领星产品表现接口单次时间范围不能超过 92 天")
    return start, end


def parse_date(value: str) -> dt.date:
    try:
        return dt.datetime.strptime(value, "%Y-%m-%d").date()
    except ValueError as exc:
        raise ValueError("日期必须是 YYYY-MM-DD: %s" % value) from exc


def date_strings(start: dt.date, end: dt.date) -> Iterable[str]:
    current = start
    while current <= end:
        yield current.isoformat()
        current += dt.timedelta(days=1)


def parse_datasets(raw: str) -> Tuple[str, ...]:
    values = tuple(dict.fromkeys(part.strip().lower() for part in raw.split(",") if part.strip()))
    unknown = set(values) - DATASET_NAMES
    if unknown:
        raise ValueError("未知数据集: %s" % ", ".join(sorted(unknown)))
    if not values:
        raise ValueError("至少选择一个数据集")
    return values


def parse_sid_filter(raw: str) -> List[int]:
    if not raw.strip():
        return []
    output: List[int] = []
    for part in raw.split(","):
        value = part.strip()
        if not value:
            continue
        try:
            output.append(int(value))
        except ValueError as exc:
            raise ValueError("店铺 sid 必须是整数: %s" % value) from exc
    return list(dict.fromkeys(output))


def select_sids(sellers: Sequence[Mapping[str, Any]], requested: Sequence[int]) -> List[int]:
    known = {_int(row.get("sid")) for row in sellers}
    known.discard(0)
    if requested:
        missing = set(requested) - known
        if missing:
            raise ValueError("以下 sid 不在领星授权店铺中: %s" % sorted(missing))
        selected = list(requested)
        if len(selected) > 200:
            raise ValueError("产品表现接口一次最多支持 200 个 sid，请缩小 LINGXING_SIDS")
        return selected
    active = [_int(row.get("sid")) for row in sellers if _int(row.get("status")) == 1]
    active = [sid for sid in active if sid]
    if not active:
        raise ValueError("没有找到状态正常的领星店铺")
    selected = list(dict.fromkeys(active))
    if len(selected) > 200:
        raise ValueError("正常店铺超过 200 个，请通过 LINGXING_SIDS 指定本看板店铺")
    return selected


def build_listing_index(
    listings: Sequence[Mapping[str, Any]],
) -> Dict[str, Dict[str, Any]]:
    output: Dict[str, Dict[str, Any]] = {}
    for row in listings:
        asin = _asin(row.get("asin"))
        if not asin:
            continue
        candidate = {
            "asin": asin,
            "pasin": _asin(row.get("parent_asin")) or asin,
            "name": _text(row.get("local_name")) or _text(row.get("item_name")),
            "sku": _text(row.get("local_sku")) or _text(row.get("seller_sku")) or asin,
            "seller_sku": _text(row.get("seller_sku")),
            "sid": _int(row.get("sid")),
            "status": _int(row.get("status")),
        }
        current = output.get(asin)
        if current is None or (candidate["status"] == 1 and current["status"] != 1):
            output[asin] = candidate
    return output


def map_performance_day(
    day: str,
    rows: Sequence[Mapping[str, Any]],
    listing_index: Mapping[str, Mapping[str, Any]],
    *,
    include_cols: bool,
) -> List[Dict[str, Any]]:
    grouped: Dict[str, Dict[str, Any]] = {}
    for row in rows:
        asin = _nested_identifier(row, "asins", "asin") or _asin(row.get("asin"))
        if not asin:
            continue
        listing = listing_index.get(asin, {})
        pasin = (
            _nested_identifier(row, "parent_asins", "parent_asin")
            or _asin(listing.get("pasin"))
            or asin
        )
        name = (
            _text(listing.get("name"))
            or _price_list_name(row.get("price_list"))
            or _text(row.get("local_name"))
            or _text(row.get("item_name"))
            or asin
        )
        record = grouped.setdefault(
            asin,
            {
                "date": day,
                "pasin": pasin,
                "asin": asin,
                "name": name,
                "sales": 0.0,
                "orders": 0.0,
                "units": 0.0,
                "sessions": 0.0,
                "gross": 0.0,
                "refund": 0.0,
                "impr": 0.0,
                "clicks": 0.0,
                "adSpend": 0.0,
                "adSales": 0.0,
                "adUnits": 0.0,
                "adOrders": 0.0,
                "cols": {},
            },
        )
        record["sales"] += _num(row.get("amount"))
        record["orders"] += _num(row.get("order_items"))
        record["units"] += _num(row.get("volume"))
        record["sessions"] += _num(
            row.get("sessions_total")
            if row.get("sessions_total") is not None
            else row.get("sessions")
        )
        record["gross"] += _num(
            row.get("predict_gross_profit")
            if row.get("predict_gross_profit") is not None
            else row.get("gross_profit")
        )
        record["refund"] += _num(row.get("return_amount"))
        record["impr"] += _num(row.get("impressions"))
        record["clicks"] += _num(row.get("clicks"))
        record["adSpend"] += _num(row.get("spend"))
        record["adSales"] += _num(row.get("ad_sales_amount"))
        ad_orders = _num(row.get("ad_order_quantity"))
        record["adOrders"] += ad_orders
        # The product-performance endpoint has no separate ad-unit field.
        record["adUnits"] += _num(row.get("ad_volume"), ad_orders)
        if include_cols:
            record["cols"].update(_performance_cols(row))

    output: List[Dict[str, Any]] = []
    for asin in sorted(grouped):
        record = grouped[asin]
        record["naturalOrders"] = record["orders"] - record["adOrders"]
        record["natClicks"] = record["sessions"] - record["clicks"]
        record["cpc"] = (
            record["adSpend"] / record["clicks"] if record["clicks"] else 0.0
        )
        output.append(_round_record(record))
    return output


def _performance_cols(row: Mapping[str, Any]) -> Dict[str, Any]:
    columns: Dict[str, Any] = {}
    direct = {
        "评分": "avg_star",
        "评论数": "reviews_count",
        "大类排名": "cate_rank",
        "促销折扣": "promotion_discount",
        "FBA可售天数预估": "available_days",
        "月库销比": "month_stock_sales_ratio",
        "净销售额": "net_amount",
        "销售均价": "avg_custom_price",
        "ROAS": "roas",
        "CPO": "cpo",
        "SP广告费": "ads_sp_cost",
        "SB广告费": "shared_ads_sb_cost",
        "SBV广告费": "shared_ads_sbv_cost",
        "SD广告费": "ads_sd_cost",
        "SP广告销售额": "ads_sp_sales",
        "SB广告销售额": "shared_ads_sb_sales",
        "SBV广告销售额": "shared_ads_sbv_sales",
        "SD广告销售额": "ads_sd_sales",
    }
    percentages = {
        "Buybox赢得率": "buy_box_percentage",
        "订单毛利率": "predict_gross_margin",
        "结算毛利率": "gross_margin",
        "ROI": "roi",
        "退款率": "return_rate",
        "ACOS": "acos",
        "ACoAS": "acoas",
        "TACOS": "tacos",
        "销量环比": "volume_chain_ratio",
        "销售额环比": "amount_chain_ratio",
        "订单量环比": "order_chain_ratio",
    }
    for label, field in direct.items():
        if row.get(field) not in (None, ""):
            columns[label] = _clean_number(row.get(field))
    for label, field in percentages.items():
        if row.get(field) not in (None, ""):
            columns[label] = round(_num(row.get(field)) * 100, 4)
    small_ranks = row.get("small_cate_rank")
    if isinstance(small_ranks, list):
        ranks = [_num(item.get("rank")) for item in small_ranks if isinstance(item, dict)]
        ranks = [rank for rank in ranks if rank > 0]
        if ranks:
            columns["小类排名"] = min(ranks)
    return {key: value for key, value in columns.items() if value not in (None, "")}


def build_stock(
    replenishment: Sequence[Mapping[str, Any]],
    inventory: Sequence[Mapping[str, Any]],
    listing_index: Mapping[str, Mapping[str, Any]],
) -> Tuple[List[Dict[str, Any]], Dict[str, str]]:
    replenishment_by_asin: Dict[str, Dict[str, Any]] = {}
    out_stock_dates: Dict[str, str] = {}
    for row in replenishment:
        basic = _mapping(row.get("basic_info"))
        asin = _asin(basic.get("asin"))
        if not asin:
            continue
        item = replenishment_by_asin.setdefault(
            asin,
            {
                "avail": 0.0,
                "fbaInTransit": 0.0,
                "pendingTransfer": 0.0,
                "inStorage": 0.0,
                "daily": {"d3": 0.0, "d7": 0.0, "d14": 0.0, "d30": 0.0, "d60": 0.0, "d90": 0.0},
            },
        )
        amazon = _mapping(row.get("amazon_quantity_info"))
        sales = _mapping(row.get("sales_info"))
        suggest = _mapping(row.get("suggest_info"))
        item["avail"] += _num(
            amazon.get("afn_fulfillable_quantity"),
            _num(amazon.get("amazon_quantity_valid")),
        )
        item["fbaInTransit"] += _num(amazon.get("amazon_quantity_shipping"))
        item["pendingTransfer"] += _num(amazon.get("reserved_fc_transfers"))
        item["inStorage"] += _num(amazon.get("reserved_fc_processing"))
        for days in (3, 7, 14, 30, 60, 90):
            item["daily"]["d%s" % days] += _num(sales.get("sales_avg_%s" % days))
        out_date = _text(suggest.get("out_stock_date"))
        if out_date and (asin not in out_stock_dates or out_date < out_stock_dates[asin]):
            out_stock_dates[asin] = out_date

    inventory_by_asin: Dict[str, Dict[str, Any]] = {}
    for row in inventory:
        asin = _asin(row.get("asin"))
        if not asin:
            continue
        item = inventory_by_asin.setdefault(
            asin,
            {
                "avail": 0.0,
                "fbaInTransit": 0.0,
                "pendingTransfer": 0.0,
                "inStorage": 0.0,
                "aging": {"a03": 0.0, "a36": 0.0, "a69": 0.0, "a912": 0.0, "a12p": 0.0},
            },
        )
        item["avail"] += _num(row.get("afn_fulfillable_quantity"))
        item["fbaInTransit"] += _num(row.get("afn_inbound_shipped_quantity"))
        item["pendingTransfer"] += _num(row.get("reserved_fc_transfers"))
        item["inStorage"] += _num(row.get("reserved_fc_processing"))
        item["aging"]["a03"] += _num(row.get("inv_age_0_to_90_days"))
        item["aging"]["a36"] += _num(row.get("inv_age_91_to_180_days"))
        item["aging"]["a69"] += _num(row.get("inv_age_181_to_270_days"))
        item["aging"]["a912"] += _num(row.get("inv_age_271_to_365_days"))
        item["aging"]["a12p"] += _num(row.get("inv_age_365_plus_days"))

    all_asins = sorted(set(replenishment_by_asin) | set(inventory_by_asin))
    output: List[Dict[str, Any]] = []
    for asin in all_asins:
        replen = replenishment_by_asin.get(asin, {})
        inv = inventory_by_asin.get(asin, {})
        listing = listing_index.get(asin, {})
        output.append(
            {
                "sku": _text(listing.get("sku")) or asin,
                "name": _text(listing.get("name")) or asin,
                "pasin": _asin(listing.get("pasin")) or asin,
                "asin": asin,
                "avail": _clean_number(replen.get("avail", inv.get("avail", 0))),
                "fbaInTransit": _clean_number(
                    replen.get("fbaInTransit", inv.get("fbaInTransit", 0))
                ),
                "pendingTransfer": _clean_number(
                    replen.get("pendingTransfer", inv.get("pendingTransfer", 0))
                ),
                "inStorage": _clean_number(
                    replen.get("inStorage", inv.get("inStorage", 0))
                ),
                "daily": {
                    key: _clean_number(value)
                    for key, value in _mapping(replen.get("daily")).items()
                }
                or {"d3": 0, "d7": 0, "d14": 0, "d30": 0, "d60": 0, "d90": 0},
                "aging": {
                    key: _clean_number(value)
                    for key, value in _mapping(inv.get("aging")).items()
                }
                or {"a03": 0, "a36": 0, "a69": 0, "a912": 0, "a12p": 0},
            }
        )
    return output, out_stock_dates


def attach_out_stock_dates(
    performance: List[Dict[str, Any]], out_stock_dates: Mapping[str, str]
) -> None:
    latest: Dict[str, Dict[str, Any]] = {}
    for row in performance:
        asin = _asin(row.get("asin"))
        if asin and (asin not in latest or row.get("date", "") > latest[asin].get("date", "")):
            latest[asin] = row
    for asin, out_date in out_stock_dates.items():
        row = latest.get(asin)
        if row is not None and out_date:
            row.setdefault("cols", {})["断货时间"] = out_date


def merge_dashboard_data(
    current: Dict[str, Any],
    *,
    performance: Optional[List[Dict[str, Any]]],
    stock: Optional[List[Dict[str, Any]]],
    synced_at: str,
) -> Dict[str, Any]:
    output = dict(current)
    if performance is not None:
        output["perf"] = dict(_mapping(output.get("perf")))
        output["perf"]["detail"] = performance
        output["ad"] = dict(_mapping(output.get("ad")))
        output["ad"]["detail"] = [
            {
                "date": row["date"],
                "name": row["name"],
                "pasin": row["pasin"],
                "asin": row["asin"],
                "spend": row["adSpend"],
                "sales": row["adSales"],
                "orders": row["adOrders"],
                "impr": row["impr"],
                "clicks": row["clicks"],
                "cpc": row["cpc"],
            }
            for row in performance
        ]
        profit = dict(_mapping(output.get("profit")))
        name_map = dict(_mapping(profit.get("nameMap")))
        profit["detail"] = [
            {
                "date": row["date"],
                "sku": row["asin"],
                "pasin": row["pasin"],
                "sales": row["sales"],
                "units": row["units"],
                "gross": row["gross"],
            }
            for row in performance
        ]
        name_map.update({row["asin"]: row["name"] for row in performance})
        profit["nameMap"] = name_map
        output["profit"] = profit
    if stock is not None:
        output["stock"] = stock
    output["_refreshedAt"] = synced_at
    return output


def validate_dashboard_data(
    data: Mapping[str, Any], datasets: Sequence[str], *, allow_empty: bool
) -> None:
    for preserved in ("mine", "promo", "tasks", "track"):
        if preserved not in data:
            raise ValueError("看板数据缺少必须保留的分区: %s" % preserved)
    if "performance" in datasets:
        rows = _mapping(data.get("perf")).get("detail")
        if not isinstance(rows, list):
            raise ValueError("perf.detail 不是数组")
        if not rows and not allow_empty:
            raise ValueError("产品表现为空；为防止误清空，未写入。确认后可用 --allow-empty")
        keys = set()
        for row in rows:
            if not isinstance(row, dict) or not row.get("date") or not row.get("asin"):
                raise ValueError("产品表现包含无日期或无 ASIN 的记录")
            key = (row["date"], row["asin"])
            if key in keys:
                raise ValueError("产品表现出现重复 date+ASIN: %s" % (key,))
            keys.add(key)
    if "stock" in datasets:
        rows = data.get("stock")
        if not isinstance(rows, list):
            raise ValueError("stock 不是数组")
        if not rows and not allow_empty:
            raise ValueError("库存为空；为防止误清空，未写入。确认后可用 --allow-empty")


def atomic_write_json(path: Path, data: Mapping[str, Any], *, indent: Optional[int] = None) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    handle = tempfile.NamedTemporaryFile(
        mode="w",
        encoding="utf-8",
        dir=str(path.parent),
        prefix=".%s." % path.name,
        suffix=".tmp",
        delete=False,
    )
    temp_path = Path(handle.name)
    try:
        with handle:
            json.dump(
                data,
                handle,
                ensure_ascii=False,
                indent=indent,
                separators=None if indent else (",", ":"),
            )
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(str(temp_path), str(path))
    except Exception:
        try:
            temp_path.unlink()
        except OSError:
            pass
        raise


def utc_now() -> str:
    return dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def main(argv: Optional[Sequence[str]] = None) -> int:
    load_dotenv(REPO_ROOT / ".env")
    try:
        args = parse_args(argv)
        datasets = parse_datasets(args.datasets)
        start, end = resolve_dates(args)
        requested_sids = parse_sid_filter(args.sids)
        client = LingxingClient(
            os.environ.get("LINGXING_APP_ID", ""),
            os.environ.get("LINGXING_APP_SECRET", ""),
            base_url=os.environ.get(
                "LINGXING_BASE_URL", "https://openapi.lingxing.com"
            ),
            timeout=float(os.environ.get("LINGXING_TIMEOUT_SECONDS", "60")),
        )

        print("[1/5] 获取领星店铺列表")
        sellers = client.sellers()
        sids = select_sids(sellers, requested_sids)
        print("      已选择 %d 个正常店铺" % len(sids))

        print("[2/5] 获取 Listing 元数据")
        listings = client.listings(sids)
        listing_index = build_listing_index(listings)
        print("      Listing %d 行，ASIN %d 个" % (len(listings), len(listing_index)))

        performance: Optional[List[Dict[str, Any]]] = None
        if "performance" in datasets:
            performance = []
            days = list(date_strings(start, end))
            print("[3/5] 逐日获取产品表现 %s 至 %s" % (start, end))
            for index, day in enumerate(days, 1):
                rows = client.product_performance(
                    sids, day, day, currency_code=args.currency.strip().upper()
                )
                mapped = map_performance_day(
                    day,
                    rows,
                    listing_index,
                    include_cols=(day == end.isoformat()),
                )
                performance.extend(mapped)
                print("      %s (%d/%d): %d ASIN" % (day, index, len(days), len(mapped)))
        else:
            print("[3/5] 跳过产品表现")

        stock: Optional[List[Dict[str, Any]]] = None
        out_stock_dates: Dict[str, str] = {}
        if "stock" in datasets:
            print("[4/5] 获取补货建议与 FBA 库存")
            replenishment = client.replenishment(sids)
            inventory = client.fba_inventory(sids)
            stock, out_stock_dates = build_stock(
                replenishment, inventory, listing_index
            )
            print(
                "      补货 %d 行，库存 %d 行，输出 %d ASIN"
                % (len(replenishment), len(inventory), len(stock))
            )
        else:
            print("[4/5] 跳过库存")

        if performance is not None and out_stock_dates:
            attach_out_stock_dates(performance, out_stock_dates)

        synced_at = utc_now()
        current = json.loads(DATA_PATH.read_text(encoding="utf-8"))
        merged = merge_dashboard_data(
            current,
            performance=performance,
            stock=stock,
            synced_at=synced_at,
        )
        validate_dashboard_data(merged, datasets, allow_empty=args.allow_empty)
        print("[5/5] 数据契约校验通过")

        if args.dry_run:
            print("DRY RUN: 未写入文件")
            return 0

        atomic_write_json(DATA_PATH, merged)
        counts = {
            "performance": len(performance or []),
            "stock": len(stock or []),
        }
        cloud_status = {
            "uploadedAt": synced_at,
            "refreshedAt": synced_at,
            "sourceType": "lingxing-openapi",
            "sourceDir": "Lingxing OpenAPI",
            "count": len(datasets),
            "files": [
                {
                    "name": "Lingxing API: %s" % name,
                    "size": counts[name],
                    "mtime": synced_at,
                }
                for name in datasets
            ],
        }
        atomic_write_json(CLOUD_STATUS_PATH, cloud_status, indent=2)

        if not args.no_build:
            from refresh_dashboard import build_release

            result = build_release(
                source_refreshed=False,
                matched=len(performance or []),
                total=len(performance or []),
            )
            if result:
                raise RuntimeError("数据已写入，但发布文件生成失败")
        print(
            "SUCCESS: performance=%d, stock=%d, uploadedAt=%s"
            % (counts["performance"], counts["stock"], synced_at)
        )
        return 0
    except (LingxingApiError, ValueError, RuntimeError, OSError, json.JSONDecodeError) as exc:
        print("FAIL: %s" % exc, file=sys.stderr)
        return 1


def _nested_identifier(row: Mapping[str, Any], field: str, key: str) -> str:
    values = row.get(field)
    if isinstance(values, list):
        for item in values:
            if isinstance(item, dict):
                value = _asin(item.get(key))
                if value:
                    return value
    return ""


def _price_list_name(value: Any) -> str:
    if isinstance(value, list):
        for item in value:
            if isinstance(item, dict):
                name = _text(item.get("local_name"))
                if name:
                    return name
    return ""


def _mapping(value: Any) -> Dict[str, Any]:
    return dict(value) if isinstance(value, dict) else {}


def _text(value: Any) -> str:
    if value is None:
        return ""
    return str(value).strip()


def _asin(value: Any) -> str:
    text = _text(value).upper()
    return "" if text in ("", "-", "NONE", "NULL") else text


def _num(value: Any, default: float = 0.0) -> float:
    if value in (None, "", "-", "—", "N/A"):
        return float(default)
    try:
        return float(str(value).replace(",", "").replace("%", ""))
    except (TypeError, ValueError):
        return float(default)


def _int(value: Any) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return 0


def _clean_number(value: Any) -> Any:
    number = _num(value)
    rounded = round(number, 4)
    return int(rounded) if rounded.is_integer() else rounded


def _round_record(record: Dict[str, Any]) -> Dict[str, Any]:
    for key in (
        "sales",
        "orders",
        "units",
        "sessions",
        "naturalOrders",
        "gross",
        "refund",
        "impr",
        "clicks",
        "natClicks",
        "adSpend",
        "adSales",
        "adUnits",
        "adOrders",
        "cpc",
    ):
        record[key] = _clean_number(record.get(key))
    return record


if __name__ == "__main__":
    raise SystemExit(main())

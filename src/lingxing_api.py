# -*- coding: utf-8 -*-
"""Small, synchronous client for Lingxing's documented OpenAPI."""

from __future__ import annotations

import base64
import hashlib
import json
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from dataclasses import dataclass
from typing import Any, Callable, Dict, Iterable, List, Mapping, Optional


DEFAULT_BASE_URL = "https://openapi.lingxing.com"
TOKEN_PATH = "/api/auth-server/oauth/access-token"
RETRYABLE_API_CODES = {2001003, 2001005, 2001007, 3001008}
TOKEN_API_CODES = {2001003, 2001005}


class LingxingApiError(RuntimeError):
    """Raised when Lingxing or the HTTP transport rejects a request."""

    def __init__(
        self,
        message: str,
        *,
        code: Optional[int] = None,
        status: Optional[int] = None,
        request_id: str = "",
    ) -> None:
        super().__init__(message)
        self.code = code
        self.status = status
        self.request_id = request_id


@dataclass
class AccessToken:
    value: str
    refresh_token: str
    expires_at: float


def _compact_json(value: Any) -> str:
    return json.dumps(
        value,
        ensure_ascii=False,
        separators=(",", ":"),
        sort_keys=True,
    )


def canonicalize_params(params: Mapping[str, Any]) -> str:
    """Format parameters exactly as Lingxing's official Python SDK does."""
    parts: List[str] = []
    for key in sorted(params):
        value = params[key]
        if value == "":
            continue
        if isinstance(value, (dict, list)):
            rendered = _compact_json(value)
        else:
            rendered = str(value)
        parts.append("%s=%s" % (key, rendered))
    return "&".join(parts)


def generate_sign(app_id: str, params: Mapping[str, Any]) -> str:
    """Generate MD5-uppercase then AES/ECB/PKCS5Padding Base64 signature."""
    try:
        from Crypto.Cipher import AES
        from Crypto.Util.Padding import pad
    except ImportError as exc:
        raise LingxingApiError(
            "缺少 pycryptodome，请先执行 pip install -r requirements-lingxing.txt"
        ) from exc

    key = app_id.encode("utf-8")
    if len(key) not in (16, 24, 32):
        raise LingxingApiError(
            "LINGXING_APP_ID 的 UTF-8 字节长度必须为 16、24 或 32，才能作为 AES 密钥"
        )
    canonical = canonicalize_params(params)
    digest = hashlib.md5(canonical.encode("utf-8")).hexdigest().upper()
    encrypted = AES.new(key, AES.MODE_ECB).encrypt(pad(digest.encode("utf-8"), 16))
    return base64.b64encode(encrypted).decode("ascii")


class UrllibJsonTransport:
    """Dependency-light HTTP transport; replaceable by a fake in tests."""

    def __init__(self, user_agent: str = "AMZ-ZK-Lingxing-Connector/1.0") -> None:
        self.user_agent = user_agent

    def request(
        self,
        method: str,
        url: str,
        *,
        query: Optional[Mapping[str, Any]] = None,
        body: Optional[Mapping[str, Any]] = None,
        form: Optional[Mapping[str, Any]] = None,
        timeout: float = 60,
    ) -> Dict[str, Any]:
        if query:
            url = "%s?%s" % (url, urllib.parse.urlencode(query))

        headers = {
            "Accept": "application/json",
            "User-Agent": self.user_agent,
        }
        payload: Optional[bytes] = None
        if body is not None:
            payload = _compact_json(body).encode("utf-8")
            headers["Content-Type"] = "application/json"
        elif form is not None:
            boundary = "----amzzk%s" % uuid.uuid4().hex
            payload = self._multipart_payload(form, boundary)
            headers["Content-Type"] = "multipart/form-data; boundary=%s" % boundary

        request = urllib.request.Request(
            url,
            data=payload,
            headers=headers,
            method=method.upper(),
        )
        try:
            with urllib.request.urlopen(request, timeout=timeout) as response:
                raw = response.read()
        except urllib.error.HTTPError as exc:
            raw = exc.read()
            detail = raw.decode("utf-8", errors="replace")[:1000]
            raise LingxingApiError(
                "领星 HTTP %s: %s" % (exc.code, detail), status=exc.code
            ) from exc
        except urllib.error.URLError as exc:
            raise LingxingApiError("连接领星失败: %s" % exc.reason) from exc

        try:
            parsed = json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise LingxingApiError("领星返回了无法解析的 JSON") from exc
        if not isinstance(parsed, dict):
            raise LingxingApiError("领星返回结构不是 JSON object")
        return parsed

    @staticmethod
    def _multipart_payload(form: Mapping[str, Any], boundary: str) -> bytes:
        chunks: List[bytes] = []
        for key, value in form.items():
            chunks.extend(
                [
                    ("--%s\r\n" % boundary).encode("ascii"),
                    (
                        'Content-Disposition: form-data; name="%s"\r\n\r\n'
                        % str(key).replace('"', "")
                    ).encode("utf-8"),
                    str(value).encode("utf-8"),
                    b"\r\n",
                ]
            )
        chunks.append(("--%s--\r\n" % boundary).encode("ascii"))
        return b"".join(chunks)


class LingxingClient:
    """Official OpenAPI facade for the datasets consumed by this dashboard."""

    def __init__(
        self,
        app_id: str,
        app_secret: str,
        *,
        base_url: str = DEFAULT_BASE_URL,
        timeout: float = 60,
        max_retries: int = 3,
        transport: Optional[Any] = None,
        clock: Callable[[], float] = time.time,
        sleeper: Callable[[float], None] = time.sleep,
    ) -> None:
        if not app_id or not app_secret:
            raise LingxingApiError("缺少 LINGXING_APP_ID 或 LINGXING_APP_SECRET")
        self.app_id = app_id
        self.app_secret = app_secret
        self.base_url = base_url.rstrip("/")
        self.timeout = timeout
        self.max_retries = max(0, max_retries)
        self.transport = transport or UrllibJsonTransport()
        self.clock = clock
        self.sleeper = sleeper
        self._token: Optional[AccessToken] = None

    def authenticate(self, *, force: bool = False) -> str:
        if (
            not force
            and self._token is not None
            and self._token.expires_at - self.clock() > 60
        ):
            return self._token.value

        payload = self.transport.request(
            "POST",
            self.base_url + TOKEN_PATH,
            form={"appId": self.app_id, "appSecret": self.app_secret},
            timeout=self.timeout,
        )
        code = _int_code(payload.get("code"))
        data = payload.get("data")
        if code != 200 or not isinstance(data, dict) or not data.get("access_token"):
            raise _response_error(payload, "获取 access_token 失败")
        expires_in = _as_float(data.get("expires_in"), 0)
        self._token = AccessToken(
            value=str(data["access_token"]),
            refresh_token=str(data.get("refresh_token") or ""),
            expires_at=self.clock() + max(expires_in, 0),
        )
        return self._token.value

    def request(
        self,
        method: str,
        path: str,
        *,
        query: Optional[Mapping[str, Any]] = None,
        body: Optional[Mapping[str, Any]] = None,
    ) -> Dict[str, Any]:
        last_error: Optional[LingxingApiError] = None
        force_token = False
        for attempt in range(self.max_retries + 1):
            access_token = self.authenticate(force=force_token)
            force_token = False
            timestamp = str(int(self.clock()))
            signing: Dict[str, Any] = dict(body or {})
            signing.update(query or {})
            signing.update(
                {
                    "access_token": access_token,
                    "app_key": self.app_id,
                    "timestamp": timestamp,
                }
            )
            common = {
                "access_token": access_token,
                "app_key": self.app_id,
                "timestamp": timestamp,
                "sign": generate_sign(self.app_id, signing),
            }
            request_query = dict(query or {})
            request_query.update(common)
            try:
                payload = self.transport.request(
                    method,
                    self.base_url + path,
                    query=request_query,
                    body=body,
                    timeout=self.timeout,
                )
            except LingxingApiError as exc:
                last_error = exc
                if attempt >= self.max_retries or not _retryable_http(exc.status):
                    raise
                self.sleeper(min(2 ** attempt, 8))
                continue

            code = _int_code(payload.get("code"))
            if code == 0:
                return payload
            error = _response_error(payload, "领星业务接口调用失败")
            last_error = error
            if code not in RETRYABLE_API_CODES or attempt >= self.max_retries:
                raise error
            if code in TOKEN_API_CODES:
                self._token = None
                force_token = True
            else:
                self.sleeper(min(2 ** attempt, 8))

        if last_error is not None:
            raise last_error
        raise LingxingApiError("领星接口调用失败")

    def sellers(self) -> List[Dict[str, Any]]:
        payload = self.request("GET", "/erp/sc/data/seller/lists")
        return _dict_rows(payload.get("data"))

    def listings(self, sids: Iterable[int]) -> List[Dict[str, Any]]:
        body = {
            "sid": ",".join(str(sid) for sid in sids),
            "is_pair": 1,
            "is_delete": 0,
        }
        return self._paginate(
            "/erp/sc/data/mws/listing", body, length=1000, nested=False
        )

    def product_performance(
        self,
        sids: Iterable[int],
        start_date: str,
        end_date: str,
        *,
        currency_code: str = "",
    ) -> List[Dict[str, Any]]:
        sid_list = list(sids)
        body: Dict[str, Any] = {
            "sort_field": "volume",
            "sort_type": "desc",
            "sid": sid_list[0] if len(sid_list) == 1 else sid_list,
            "start_date": start_date,
            "end_date": end_date,
            "summary_field": "asin",
            "is_recently_enum": False,
            "purchase_status": 0,
        }
        if currency_code:
            body["currency_code"] = currency_code
        return self._paginate(
            "/bd/productPerformance/openApi/asinList",
            body,
            length=10000,
            nested=True,
        )

    def replenishment(self, sids: Iterable[int]) -> List[Dict[str, Any]]:
        body = {"sid_list": [str(sid) for sid in sids], "data_type": 1}
        return self._paginate(
            "/erp/sc/routing/restocking/analysis/getSummaryList",
            body,
            length=50,
            nested=False,
        )

    def fba_inventory(self, sids: Iterable[int]) -> List[Dict[str, Any]]:
        body = {
            "sid": ",".join(str(sid) for sid in sids),
            "is_hide_zero_stock": "0",
            "is_parant_asin_merge": "0",
            "is_contain_del_ls": "0",
        }
        return self._paginate(
            "/basicOpen/openapi/storage/fbaWarehouseDetail",
            body,
            length=200,
            nested=False,
        )

    def promotions(
        self,
        sids: Iterable[int],
        site_date: str,
        *,
        start_time: str = "",
        end_time: str = "",
    ) -> List[Dict[str, Any]]:
        body: Dict[str, Any] = {"site_date": site_date, "sids": list(sids)}
        if start_time:
            body["start_time"] = start_time
        if end_time:
            body["end_time"] = end_time
        return self._paginate(
            "/basicOpen/promotion/listingList", body, length=200, nested=False
        )

    def _paginate(
        self,
        path: str,
        base_body: Mapping[str, Any],
        *,
        length: int,
        nested: bool,
    ) -> List[Dict[str, Any]]:
        offset = 0
        output: List[Dict[str, Any]] = []
        for _ in range(10000):
            body = dict(base_body)
            body.update({"offset": offset, "length": length})
            payload = self.request("POST", path, body=body)
            container = payload.get("data")
            if nested:
                if not isinstance(container, dict):
                    raise LingxingApiError("分页接口 data 结构异常")
                rows = _dict_rows(container.get("list"))
                total = _as_int(container.get("total"), len(output) + len(rows))
            else:
                rows = _dict_rows(container)
                total = _as_int(payload.get("total"), len(output) + len(rows))
            output.extend(rows)
            offset += len(rows)
            if not rows or offset >= total:
                return output
        raise LingxingApiError("分页超过 10000 页，已停止以避免无限循环")


def _dict_rows(value: Any) -> List[Dict[str, Any]]:
    if not isinstance(value, list):
        return []
    return [item for item in value if isinstance(item, dict)]


def _int_code(value: Any) -> Optional[int]:
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def _as_int(value: Any, default: int = 0) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def _as_float(value: Any, default: float = 0) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


def _retryable_http(status: Optional[int]) -> bool:
    return status == 429 or (status is not None and 500 <= status < 600)


def _response_error(payload: Mapping[str, Any], prefix: str) -> LingxingApiError:
    code = _int_code(payload.get("code"))
    message = payload.get("message") or payload.get("msg") or "unknown error"
    request_id = str(payload.get("request_id") or payload.get("trace_id") or "")
    suffix = " [request_id=%s]" % request_id if request_id else ""
    return LingxingApiError(
        "%s: code=%s, %s%s" % (prefix, code, message, suffix),
        code=code,
        request_id=request_id,
    )

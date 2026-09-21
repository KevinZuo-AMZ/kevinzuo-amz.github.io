# -*- coding: utf-8 -*-
"""Loopback-only bridge between the public dashboard and Lingxing OpenAPI.

The browser receives only an ephemeral pairing key. Lingxing and GitHub
credentials remain in this process environment and are never returned by the
HTTP API.
"""

from __future__ import annotations

import argparse
import hmac
import ipaddress
import json
import os
import re
import secrets
import subprocess
import sys
import threading
from dataclasses import dataclass
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Dict, Iterable, Mapping, Optional, Sequence, Tuple
from urllib.parse import urlsplit

from lingxing_api import LingxingApiError, LingxingClient
from sync_lingxing_api import load_dotenv, parse_sid_filter, select_sids


BASE = Path(__file__).resolve().parent
REPO_ROOT = BASE.parent
DATA_PATH = REPO_ROOT / "amz-data.json"
CLOUD_STATUS_PATH = REPO_ROOT / "cloud-status.json"
SYNC_SCRIPT = BASE / "sync_lingxing_api.py"
PUSH_SCRIPT = BASE / "push_data.py"
BRIDGE_VERSION = "1"
DEFAULT_HOST = "127.0.0.1"
DEFAULT_PORT = 8765
MAX_BODY_BYTES = 32 * 1024
DEFAULT_ALLOWED_ORIGINS = ("https://kevinzuo-amz.github.io",)
DATASETS = ("performance", "stock")
TOKEN_PATTERN = re.compile(
    r"(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|"
    r"\b(?:access|refresh)[_-]?token\b\s*[:=]\s*[^\s,;]+)",
    re.IGNORECASE,
)


class BridgeProblem(RuntimeError):
    def __init__(
        self,
        message: str,
        *,
        status: int = 400,
        code: str = "BAD_REQUEST",
        details: Optional[Mapping[str, Any]] = None,
    ) -> None:
        super().__init__(message)
        self.status = status
        self.code = code
        self.details = dict(details or {})


@dataclass(frozen=True)
class SyncOptions:
    days: int
    datasets: Tuple[str, ...]
    include_today: bool = False
    publish: bool = False


class BridgeRuntime:
    def __init__(
        self,
        pair_key: str,
        *,
        allowed_origins: Iterable[str] = DEFAULT_ALLOWED_ORIGINS,
        sync_timeout: int = 1800,
        publish_timeout: int = 300,
    ) -> None:
        if len(pair_key) < 16:
            raise ValueError("配对码至少需要 16 个字符")
        self.pair_key = pair_key
        self.allowed_origins = tuple(
            origin.rstrip("/") for origin in allowed_origins if origin.strip()
        )
        self.sync_timeout = sync_timeout
        self.publish_timeout = publish_timeout
        self.sync_lock = threading.Lock()


def is_loopback_host(host_header: str) -> bool:
    """Reject DNS-rebinding hosts even though the server binds to loopback."""
    if not host_header:
        return False
    try:
        hostname = urlsplit("//" + host_header.strip()).hostname or ""
    except ValueError:
        return False
    if hostname.lower() == "localhost":
        return True
    try:
        return ipaddress.ip_address(hostname).is_loopback
    except ValueError:
        return False


def is_allowed_origin(origin: str, allowed_origins: Sequence[str]) -> bool:
    """Allow the deployed dashboard, local development, and file previews."""
    if not origin:
        return True
    if origin == "null":
        return True
    try:
        parsed = urlsplit(origin)
    except ValueError:
        return False
    normalized = "%s://%s" % (parsed.scheme.lower(), parsed.netloc.lower())
    if normalized.rstrip("/") in {item.lower() for item in allowed_origins}:
        return True
    if parsed.scheme.lower() not in ("http", "https"):
        return False
    hostname = (parsed.hostname or "").lower()
    if hostname == "localhost":
        return True
    try:
        return ipaddress.ip_address(hostname).is_loopback
    except ValueError:
        return False


def normalize_sync_request(payload: Mapping[str, Any]) -> SyncOptions:
    if not isinstance(payload, Mapping):
        raise BridgeProblem("请求体必须是 JSON object")
    raw_days = payload.get("days", 7)
    if isinstance(raw_days, bool):
        raise BridgeProblem("同步天数必须是 1 到 92 的整数")
    try:
        days = int(raw_days)
    except (TypeError, ValueError) as exc:
        raise BridgeProblem("同步天数必须是 1 到 92 的整数") from exc
    if not 1 <= days <= 92:
        raise BridgeProblem("同步天数必须在 1 到 92 之间")

    raw_datasets = payload.get("datasets", DATASETS)
    if not isinstance(raw_datasets, (list, tuple)):
        raise BridgeProblem("数据集必须是数组")
    datasets = tuple(
        dict.fromkeys(
            str(value).strip().lower()
            for value in raw_datasets
            if str(value).strip()
        )
    )
    unknown = set(datasets) - set(DATASETS)
    if unknown:
        raise BridgeProblem("未知数据集: %s" % ", ".join(sorted(unknown)))
    if not datasets:
        raise BridgeProblem("至少选择一个数据集")

    include_today = payload.get("includeToday", False)
    publish = payload.get("publish", False)
    if not isinstance(include_today, bool) or not isinstance(publish, bool):
        raise BridgeProblem("includeToday 和 publish 必须是布尔值")
    return SyncOptions(
        days=days,
        datasets=datasets,
        include_today=include_today,
        publish=publish,
    )


def build_sync_command(
    options: SyncOptions, python_executable: str = sys.executable
) -> Sequence[str]:
    command = [
        python_executable,
        str(SYNC_SCRIPT),
        "--days",
        str(options.days),
        "--datasets",
        ",".join(options.datasets),
    ]
    if options.include_today:
        command.append("--include-today")
    return command


def configured_origins(extra: Sequence[str] = ()) -> Tuple[str, ...]:
    raw = os.environ.get("LINGXING_BRIDGE_ALLOWED_ORIGINS", "")
    env_origins = tuple(item.strip() for item in raw.split(",") if item.strip())
    return tuple(dict.fromkeys(DEFAULT_ALLOWED_ORIGINS + env_origins + tuple(extra)))


def credentials_configured() -> bool:
    return bool(
        os.environ.get("LINGXING_APP_ID", "").strip()
        and os.environ.get("LINGXING_APP_SECRET", "").strip()
    )


def read_json(path: Path) -> Dict[str, Any]:
    try:
        parsed = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return {}
    except (OSError, json.JSONDecodeError) as exc:
        raise BridgeProblem(
            "%s 无法读取或不是有效 JSON" % path.name,
            status=500,
            code="LOCAL_DATA_INVALID",
        ) from exc
    if not isinstance(parsed, dict):
        raise BridgeProblem(
            "%s 顶层必须是 JSON object" % path.name,
            status=500,
            code="LOCAL_DATA_INVALID",
        )
    return parsed


def data_summary() -> Dict[str, Any]:
    status = read_json(CLOUD_STATUS_PATH)
    data = read_json(DATA_PATH)
    perf = data.get("perf") if isinstance(data.get("perf"), dict) else {}
    ad = data.get("ad") if isinstance(data.get("ad"), dict) else {}
    profit = data.get("profit") if isinstance(data.get("profit"), dict) else {}
    return {
        "syncedAt": status.get("uploadedAt") or status.get("refreshedAt") or "",
        "sourceType": status.get("sourceType") or "",
        "counts": {
            "performance": len(perf.get("detail") or []),
            "stock": len(data.get("stock") or []),
            "ads": len(ad.get("detail") or []),
            "profit": len(profit.get("detail") or []),
        },
    }


def sanitize_output(value: str, limit: int = 1800) -> str:
    output = value or ""
    for name in (
        "LINGXING_APP_ID",
        "LINGXING_APP_SECRET",
        "GITHUB_TOKEN",
    ):
        secret = os.environ.get(name, "")
        if secret:
            output = output.replace(secret, "[REDACTED]")
    output = TOKEN_PATTERN.sub("[REDACTED]", output)
    return output.strip()[-limit:]


def run_command(command: Sequence[str], timeout: int) -> subprocess.CompletedProcess:
    try:
        return subprocess.run(
            list(command),
            cwd=str(REPO_ROOT),
            env=os.environ.copy(),
            capture_output=True,
            text=True,
            timeout=timeout,
            check=False,
        )
    except subprocess.TimeoutExpired as exc:
        raise BridgeProblem(
            "本机任务执行超时",
            status=504,
            code="LOCAL_TASK_TIMEOUT",
        ) from exc
    except OSError as exc:
        raise BridgeProblem(
            "无法启动本机同步脚本",
            status=500,
            code="LOCAL_TASK_START_FAILED",
        ) from exc


def run_lingxing_test() -> Dict[str, Any]:
    if not credentials_configured():
        raise BridgeProblem(
            "尚未在本机 .env 配置领星 AppID 和 AppSecret",
            status=409,
            code="CREDENTIALS_MISSING",
        )
    try:
        client = LingxingClient(
            os.environ.get("LINGXING_APP_ID", ""),
            os.environ.get("LINGXING_APP_SECRET", ""),
            base_url=os.environ.get(
                "LINGXING_BASE_URL", "https://openapi.lingxing.com"
            ),
            timeout=float(os.environ.get("LINGXING_TIMEOUT_SECONDS", "60")),
        )
        sellers = client.sellers()
        selected = select_sids(
            sellers, parse_sid_filter(os.environ.get("LINGXING_SIDS", ""))
        )
    except (LingxingApiError, ValueError) as exc:
        raise BridgeProblem(
            sanitize_output(str(exc)),
            status=502,
            code="LINGXING_TEST_FAILED",
        ) from exc
    return {
        "ok": True,
        "message": "领星鉴权与店铺读取成功",
        "sellerCount": len(sellers),
        "selectedSellerCount": len(selected),
    }


def run_lingxing_sync(options: SyncOptions, runtime: BridgeRuntime) -> Dict[str, Any]:
    if not credentials_configured():
        raise BridgeProblem(
            "尚未在本机 .env 配置领星 AppID 和 AppSecret",
            status=409,
            code="CREDENTIALS_MISSING",
        )
    if not runtime.sync_lock.acquire(blocking=False):
        raise BridgeProblem(
            "已有领星同步正在运行",
            status=409,
            code="SYNC_IN_PROGRESS",
        )
    try:
        sync_result = run_command(
            build_sync_command(options), timeout=runtime.sync_timeout
        )
        sync_output = "\n".join((sync_result.stdout, sync_result.stderr))
        if sync_result.returncode:
            raise BridgeProblem(
                sanitize_output(sync_output) or "领星同步失败",
                status=502,
                code="LINGXING_SYNC_FAILED",
            )

        summary = data_summary()
        response: Dict[str, Any] = {
            "ok": True,
            "message": "领星数据已同步到本机看板",
            "days": options.days,
            "datasets": list(options.datasets),
            "published": False,
            **summary,
        }
        if options.publish:
            publish_result = run_command(
                [sys.executable, str(PUSH_SCRIPT)],
                timeout=runtime.publish_timeout,
            )
            publish_output = "\n".join(
                (publish_result.stdout, publish_result.stderr)
            )
            if publish_result.returncode:
                raise BridgeProblem(
                    sanitize_output(publish_output) or "本机同步成功，但 GitHub 发布失败",
                    status=502,
                    code="PUBLISH_FAILED",
                    details={"syncCompleted": True, **summary},
                )
            response["published"] = True
            response["message"] = "领星数据已同步并发布到 GitHub"
        return response
    finally:
        runtime.sync_lock.release()


class LingxingBridgeHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    runtime: BridgeRuntime

    def log_message(self, fmt: str, *args: Any) -> None:
        sys.stdout.write("[bridge] %s\n" % (fmt % args))
        sys.stdout.flush()

    def _origin(self) -> str:
        return self.headers.get("Origin", "")

    def _send_json(
        self, status: int, payload: Mapping[str, Any], *, include_cors: bool = True
    ) -> None:
        body = json.dumps(
            dict(payload), ensure_ascii=False, separators=(",", ":")
        ).encode("utf-8")
        self.send_response(status)
        origin = self._origin()
        if (
            include_cors
            and origin
            and is_allowed_origin(origin, self.runtime.allowed_origins)
        ):
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Vary", "Origin")
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def _send_problem(self, problem: BridgeProblem) -> None:
        payload: Dict[str, Any] = {
            "ok": False,
            "code": problem.code,
            "message": sanitize_output(str(problem)),
        }
        payload.update(problem.details)
        self._send_json(problem.status, payload)

    def _validate_transport(self) -> None:
        if not is_loopback_host(self.headers.get("Host", "")):
            raise BridgeProblem(
                "连接器只接受 localhost 或 127.0.0.1",
                status=421,
                code="HOST_REJECTED",
            )
        origin = self._origin()
        if not is_allowed_origin(origin, self.runtime.allowed_origins):
            raise BridgeProblem(
                "当前网页来源未获准访问本机连接器",
                status=403,
                code="ORIGIN_REJECTED",
            )

    def _authenticate(self) -> None:
        supplied = self.headers.get("X-AMZ-Bridge-Key", "")
        if not supplied or not hmac.compare_digest(supplied, self.runtime.pair_key):
            raise BridgeProblem(
                "配对码无效或已失效",
                status=401,
                code="PAIRING_REQUIRED",
            )

    def _read_payload(self) -> Dict[str, Any]:
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError as exc:
            raise BridgeProblem("Content-Length 无效") from exc
        if length < 0 or length > MAX_BODY_BYTES:
            raise BridgeProblem(
                "请求体过大",
                status=413,
                code="BODY_TOO_LARGE",
            )
        raw = self.rfile.read(length) if length else b"{}"
        try:
            payload = json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise BridgeProblem("请求体不是有效 JSON") from exc
        if not isinstance(payload, dict):
            raise BridgeProblem("请求体必须是 JSON object")
        return payload

    def do_OPTIONS(self) -> None:
        try:
            self._validate_transport()
            self.send_response(204)
            origin = self._origin()
            if origin:
                self.send_header("Access-Control-Allow-Origin", origin)
                self.send_header("Vary", "Origin")
            self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
            self.send_header(
                "Access-Control-Allow-Headers",
                "Content-Type, X-AMZ-Bridge-Key",
            )
            self.send_header("Access-Control-Max-Age", "600")
            if (
                self.headers.get(
                    "Access-Control-Request-Private-Network", ""
                ).lower()
                == "true"
            ):
                self.send_header("Access-Control-Allow-Private-Network", "true")
            self.send_header("Content-Length", "0")
            self.end_headers()
        except BridgeProblem as problem:
            self._send_problem(problem)

    def do_GET(self) -> None:
        try:
            self._validate_transport()
            self._authenticate()
            path = urlsplit(self.path).path
            if path == "/api/status":
                summary = data_summary()
                self._send_json(
                    200,
                    {
                        "ok": True,
                        "connectorVersion": BRIDGE_VERSION,
                        "credentialsConfigured": credentials_configured(),
                        "busy": self.runtime.sync_lock.locked(),
                        "dataReady": DATA_PATH.exists(),
                        **summary,
                    },
                )
                return
            if path == "/api/data":
                data = read_json(DATA_PATH)
                if not data:
                    raise BridgeProblem(
                        "本机尚无可加载的 amz-data.json",
                        status=404,
                        code="LOCAL_DATA_MISSING",
                    )
                self._send_json(200, data)
                return
            raise BridgeProblem("接口不存在", status=404, code="NOT_FOUND")
        except BridgeProblem as problem:
            self._send_problem(problem)
        except Exception as exc:
            self._send_problem(
                BridgeProblem(
                    sanitize_output(str(exc)),
                    status=500,
                    code="INTERNAL_ERROR",
                )
            )

    def do_POST(self) -> None:
        try:
            self._validate_transport()
            self._authenticate()
            path = urlsplit(self.path).path
            payload = self._read_payload()
            if path == "/api/test":
                if not self.runtime.sync_lock.acquire(blocking=False):
                    raise BridgeProblem(
                        "同步运行期间暂不能测试连接",
                        status=409,
                        code="SYNC_IN_PROGRESS",
                    )
                try:
                    self._send_json(200, run_lingxing_test())
                finally:
                    self.runtime.sync_lock.release()
                return
            if path == "/api/sync":
                options = normalize_sync_request(payload)
                self._send_json(200, run_lingxing_sync(options, self.runtime))
                return
            raise BridgeProblem("接口不存在", status=404, code="NOT_FOUND")
        except BridgeProblem as problem:
            self._send_problem(problem)
        except Exception as exc:
            self._send_problem(
                BridgeProblem(
                    sanitize_output(str(exc)),
                    status=500,
                    code="INTERNAL_ERROR",
                )
            )


def make_handler(runtime: BridgeRuntime):
    class BoundLingxingBridgeHandler(LingxingBridgeHandler):
        pass

    BoundLingxingBridgeHandler.runtime = runtime
    return BoundLingxingBridgeHandler


def parse_args(argv: Optional[Sequence[str]] = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="启动 AMZ-ZK 看板使用的本机领星 API 连接器"
    )
    parser.add_argument(
        "--host",
        default=os.environ.get("LINGXING_BRIDGE_HOST", DEFAULT_HOST),
        help="只允许回环地址，默认 127.0.0.1",
    )
    parser.add_argument(
        "--port",
        type=int,
        default=int(os.environ.get("LINGXING_BRIDGE_PORT", str(DEFAULT_PORT))),
        help="本机端口，默认 8765",
    )
    parser.add_argument(
        "--allowed-origin",
        action="append",
        default=[],
        help="额外允许的网页 Origin，可重复指定",
    )
    return parser.parse_args(argv)


def validate_bind_host(host: str) -> None:
    if host.lower() == "localhost":
        return
    try:
        if ipaddress.ip_address(host).is_loopback:
            return
    except ValueError:
        pass
    raise ValueError("连接器只能监听 localhost、127.0.0.1 或其他回环地址")


def main(argv: Optional[Sequence[str]] = None) -> int:
    load_dotenv(REPO_ROOT / ".env")
    args = parse_args(argv)
    try:
        validate_bind_host(args.host)
        if not 1 <= args.port <= 65535:
            raise ValueError("端口必须在 1 到 65535 之间")
        pair_key = os.environ.get("LINGXING_BRIDGE_KEY", "").strip()
        if not pair_key:
            pair_key = secrets.token_urlsafe(24)
        runtime = BridgeRuntime(
            pair_key,
            allowed_origins=configured_origins(args.allowed_origin),
            sync_timeout=int(
                os.environ.get("LINGXING_BRIDGE_SYNC_TIMEOUT", "1800")
            ),
            publish_timeout=int(
                os.environ.get("LINGXING_BRIDGE_PUBLISH_TIMEOUT", "300")
            ),
        )
        server = ThreadingHTTPServer(
            (args.host, args.port),
            make_handler(runtime),
        )
        server.daemon_threads = True
    except (OSError, ValueError) as exc:
        print("FAIL: %s" % exc, file=sys.stderr)
        return 2

    print("领星本机连接器已启动")
    print("连接地址: http://%s:%d" % (args.host, args.port))
    print("本次配对码: %s" % pair_key)
    print(
        "凭证状态: %s"
        % ("已配置" if credentials_configured() else "未配置，请检查项目根目录 .env")
    )
    print("保持此终端运行；按 Ctrl+C 停止。")
    try:
        server.serve_forever(poll_interval=0.25)
    except KeyboardInterrupt:
        print("\n连接器已停止")
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
